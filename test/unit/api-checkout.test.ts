// POST /api/checkout, with the database and the payment provider both faked.
//
// What is worth testing without a real database is the part a student actually sees:
// which failures come back as which code. A booking form that says "something went
// wrong" for a stale calendar and for a lost race is a form nobody can use.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleCheckout } from '../../src/api/checkout.ts';
import { HOLD_GRACE_SECONDS } from '../../src/booking.ts';
import { FakePaymentProvider } from '../support/fake-payments.ts';

// Friday 2026-11-20, Alex open 18:00-22:00 Chicago. 18:00 CST is 2026-11-21T00:00Z.
const NOW = new Date('2026-11-20T12:00:00Z');
const START = '2026-11-21T00:00:00Z';

const VALID = {
  sku: 'live_coaching',
  start: START,
  studentDiscordId: '123456789012345678',
  studentEmail: 'student@example.com',
  riotId: 'Faker#KR1',
  studentTz: 'America/New_York',
};

interface FakeDbOptions {
  /** Rows already occupying time, as the reserved-range query would return them. */
  reserved?: { starts: string; ends: string }[];
  /** Thrown by the INSERT into reservations, to stand in for a lost race. */
  insertError?: unknown;
}

/** Answers the five statements createHold issues, and records them in order. */
function fakeDb(options: FakeDbOptions = {}) {
  const statements: string[] = [];
  return {
    statements,
    async query(sql: string, _params?: unknown[]): Promise<{ rows: unknown[] }> {
      statements.push(sql.trim().split('\n')[0]!.trim());
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] };
      if (sql.includes('FROM availability_rules')) {
        return {
          rows: [
            { weekday: 5, start_local: '18:00:00', end_local: '22:00:00', tz: 'America/Chicago' },
          ],
        };
      }
      if (sql.includes('FROM reservations')) return { rows: options.reserved ?? [] };
      if (sql.includes('INSERT INTO reservations')) {
        if (options.insertError) throw options.insertError;
        return { rows: [{ id: '11' }] };
      }
      if (sql.includes('INSERT INTO bookings')) return { rows: [{ id: '22' }] };
      return { rows: [] };
    },
  };
}

const overlapError = () =>
  Object.assign(new Error('conflicting key value violates exclusion constraint'), {
    code: '23P01',
    constraint: 'reservations_no_overlap',
  });

describe('POST /api/checkout validation', () => {
  test('a non-object body is refused before anything else', async () => {
    const db = fakeDb();
    const result = await handleCheckout(db, new FakePaymentProvider(), 'nope', NOW);
    assert.equal(result.status, 400);
    assert.equal((result.body as { error: { code: string } }).error.code, 'bad_body');
    assert.deepEqual(db.statements, [], 'no transaction should have been opened');
  });

  test('every missing field is named at once, not one per round trip', async () => {
    const { sku, start } = VALID;
    const result = await handleCheckout(fakeDb(), new FakePaymentProvider(), { sku, start }, NOW);
    assert.equal(result.status, 400);
    const error = (result.body as { error: { code: string; fields: string[] } }).error;
    assert.equal(error.code, 'missing_fields');
    assert.deepEqual(error.fields, ['studentDiscordId', 'studentEmail', 'riotId', 'studentTz']);
  });

  test('an unknown sku is a 400, not a 500 from the price lookup', async () => {
    const result = await handleCheckout(
      fakeDb(), new FakePaymentProvider(), { ...VALID, sku: 'free_coaching' }, NOW,
    );
    assert.equal(result.status, 400);
    assert.equal((result.body as { error: { code: string } }).error.code, 'bad_sku');
  });

  test('a Riot ID without a tag is refused', async () => {
    const result = await handleCheckout(
      fakeDb(), new FakePaymentProvider(), { ...VALID, riotId: 'Faker' }, NOW,
    );
    assert.equal((result.body as { error: { code: string } }).error.code, 'bad_riot_id');
  });

  test('a Discord username is not a snowflake', async () => {
    const result = await handleCheckout(
      fakeDb(), new FakePaymentProvider(), { ...VALID, studentDiscordId: 'faker#0001' }, NOW,
    );
    assert.equal((result.body as { error: { code: string } }).error.code, 'bad_discord_id');
  });

  test('an unparseable start is refused before the transaction opens', async () => {
    const db = fakeDb();
    const result = await handleCheckout(
      db, new FakePaymentProvider(), { ...VALID, start: 'next friday' }, NOW,
    );
    assert.equal((result.body as { error: { code: string } }).error.code, 'bad_start');
    assert.deepEqual(db.statements, []);
  });
});

describe('POST /api/checkout conflicts', () => {
  test('a start inside the lead time is 409 too_soon, however the calendar looked', async () => {
    // 20 minutes out: a tab left open since this morning would still be offering it.
    const soon = new Date(NOW.getTime() + 20 * 60_000).toISOString();
    const result = await handleCheckout(
      fakeDb(), new FakePaymentProvider(), { ...VALID, start: soon }, NOW,
    );
    assert.equal(result.status, 409);
    assert.equal((result.body as { error: { code: string } }).error.code, 'too_soon');
  });

  test('a 4 AM start is not_offered even though nothing is reserved', async () => {
    // The exclusion constraint would happily accept this. Open hours are not its job.
    const result = await handleCheckout(
      fakeDb(), new FakePaymentProvider(), { ...VALID, start: '2026-11-21T10:00:00Z' }, NOW,
    );
    assert.equal(result.status, 409);
    assert.equal((result.body as { error: { code: string } }).error.code, 'not_offered');
  });

  test('a start off the 15-minute grid is not_offered', async () => {
    const result = await handleCheckout(
      fakeDb(), new FakePaymentProvider(), { ...VALID, start: '2026-11-21T00:07:00Z' }, NOW,
    );
    assert.equal((result.body as { error: { code: string } }).error.code, 'not_offered');
  });

  test('losing the race is slot_taken, distinct from a stale calendar', async () => {
    const result = await handleCheckout(
      fakeDb({ insertError: overlapError() }), new FakePaymentProvider(), VALID, NOW,
    );
    assert.equal(result.status, 409);
    const error = (result.body as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'slot_taken');
    assert.match(error.message, /just taken/);
  });

  test('a provider failure is 502 and rolls back', async () => {
    const db = fakeDb();
    const provider = new FakePaymentProvider({ failWith: 'stripe unreachable' });
    const result = await handleCheckout(db, provider, VALID, NOW);
    assert.equal(result.status, 502);
    assert.equal((result.body as { error: { code: string } }).error.code, 'provider_failed');
    assert.ok(db.statements.includes('ROLLBACK'), 'the transaction must be rolled back');
    assert.ok(!db.statements.includes('COMMIT'));
  });
});

describe('POST /api/checkout success', () => {
  test('a valid booking commits and returns the checkout URL', async () => {
    const db = fakeDb();
    const provider = new FakePaymentProvider();
    const result = await handleCheckout(db, provider, VALID, NOW);

    assert.equal(result.status, 201);
    const body = result.body as { bookingId: string; checkoutUrl: string; priceCents: number };
    assert.equal(body.bookingId, '22');
    assert.match(body.checkoutUrl, /^https:\/\/checkout\.example\//);
    assert.equal(body.priceCents, 4000, 'live_coaching is $40, from the SKU table');
    assert.ok(db.statements.includes('COMMIT'));

    // The provider is told the booking id, so its webhook can find the row again.
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(provider.calls[0], {
      bookingId: '22', sku: 'live_coaching', priceCents: 4000, email: 'student@example.com',
    });
  });

  test('the hold outlives the payment session by the grace period', async () => {
    // The sweeper must not reap a hold while the student can still pay: the provider's
    // own expiry is the earliest they can be cut off, and this adds a margin to it.
    const provider = new FakePaymentProvider({ expiresInMinutes: 30 });
    const result = await handleCheckout(fakeDb(), provider, VALID, NOW);
    const { holdExpiresAt } = result.body as { holdExpiresAt: string };
    const sessionExpiry = provider.calls.length > 0 ? new Date(holdExpiresAt) : null;
    assert.ok(sessionExpiry);
    const margin = sessionExpiry.getTime() - (Date.now() + 30 * 60_000);
    assert.ok(
      Math.abs(margin - HOLD_GRACE_SECONDS * 1000) < 2_000,
      `expected ~${HOLD_GRACE_SECONDS}s of grace, got ${Math.round(margin / 1000)}s`,
    );
  });

  test('the hold is reserved for the SKU duration, not a fixed hour', async () => {
    const result = await handleCheckout(fakeDb(), new FakePaymentProvider(), { ...VALID, sku: 'both' }, NOW);
    assert.equal(result.status, 201);
    const body = result.body as { startsAt: string; endsAt: string; priceCents: number };
    assert.equal(body.startsAt, new Date(START).toISOString());
    assert.equal(body.endsAt, '2026-11-21T02:00:00.000Z', 'Both is two hours');
    assert.equal(body.priceCents, 6000);
  });

  test('the slot is checked against reserved ranges inside the transaction', async () => {
    // The 18:00 hour is already taken, so the hold must not even be attempted.
    const db = fakeDb({
      reserved: [{ starts: '2026-11-21T00:00:00Z', ends: '2026-11-21T01:15:00Z' }],
    });
    const result = await handleCheckout(db, new FakePaymentProvider(), VALID, NOW);
    assert.equal((result.body as { error: { code: string } }).error.code, 'not_offered');
    assert.ok(!db.statements.some((s) => s.includes('INSERT INTO reservations')));
  });
});
