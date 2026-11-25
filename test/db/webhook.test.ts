// The webhook against a real PostgreSQL, from a real hold.
//
// The unit tests cover which outcome each situation produces. These cover the three
// things only the database decides: that the exclusion constraint is what refuses to
// reclaim a resold hour, that the dedupe row and the state change really do commit or
// roll back together, and that a paid booking comes out the far end with a window and
// its due work.
//
// Needs DATABASE_URL, read from .env by `npm run test:db`. See test/db/schema.test.ts
// for how to get one.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHold, type Hold, type HoldInput } from '../../src/booking.ts';
import { handleWebhook } from '../../src/api/webhook.ts';
import type { Queryable } from '../../src/db/queries.ts';
import { sweepDueWork } from '../../src/worker/sweep.ts';
import { FakePaymentProvider, FakeWebhookVerifier, paymentEvent } from '../support/fake-payments.ts';

const url = process.env.DATABASE_URL;
const db = new pg.Client({ connectionString: url });

const NOW = new Date('2026-11-20T12:00:00Z');
const START = '2026-11-21T00:00:00.000Z';
const END = '2026-11-21T01:00:00.000Z';
const SIG = FakeWebhookVerifier.VALID_SIGNATURE;
const verifier = new FakeWebhookVerifier();

const INPUT: HoldInput = {
  sku: 'live_coaching',
  start: START,
  studentDiscordId: '123456789012345678',
  studentEmail: 'student@example.com',
  riotId: 'Faker#KR1',
  studentTz: 'America/New_York',
};

const outcomeOf = (body: unknown) => (body as { outcome: string }).outcome;

/** The event Stripe would send for a hold, naming it by session and by metadata. */
function paidEvent(hold: Hold, overrides: Record<string, unknown> = {}) {
  return JSON.stringify(
    paymentEvent({ sessionId: hold.sessionId, bookingId: hold.bookingId, ...overrides }),
  );
}

async function stateOf(bookingId: string) {
  const { rows } = await db.query(
    `SELECT b.state, r.holds_slot FROM bookings b
       JOIN reservations r ON r.id = b.reservation_id WHERE b.id = $1`,
    [bookingId],
  );
  return rows[0] as { state: string; holds_slot: boolean };
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return (rows[0] as { n: number }).n;
}

/**
 * Wraps the client so one statement throws, standing in for the process dying partway
 * through the handler. Everything else, ROLLBACK included, passes through.
 */
function failingOnce(needle: string): Queryable {
  let fired = false;
  return {
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      if (!fired && sql.includes(needle)) {
        fired = true;
        throw new Error(`simulated crash in ${needle}`);
      }
      return db.query(sql, params);
    },
  };
}

before(async () => {
  assert.ok(
    url,
    'DATABASE_URL is unset, and no .env was found for the test script to read.\n' +
      '  cp .env.example .env     (then `npm run db:up` if Postgres is not running)',
  );
  await db.connect();
});

after(async () => {
  await db.end();
});

beforeEach(async () => {
  await db.query('TRUNCATE reservations, availability_rules, processed_events CASCADE');
  await db.query(
    `INSERT INTO availability_rules (weekday, start_local, end_local, tz)
     VALUES (5, '18:00', '22:00', 'America/Chicago')`,
  );
});

describe('a paid booking, end to end', () => {
  test('the booking is paid, the window is granted, and the work is queued', async () => {
    const hold = await createHold(db, new FakePaymentProvider({ now: NOW }), INPUT, NOW);
    const result = await handleWebhook(db, verifier, paidEvent(hold), SIG, NOW);

    assert.equal(result.status, 200);
    assert.equal(outcomeOf(result.body), 'paid');
    assert.deepEqual(await stateOf(hold.bookingId), { state: 'paid', holds_slot: true });

    const { rows: entitlements } = await db.query(
      'SELECT state, starts_at, ends_at FROM entitlements WHERE booking_id = $1',
      [hold.bookingId],
    );
    const entitlement = entitlements[0] as { state: string; starts_at: Date; ends_at: Date };
    assert.equal(entitlement.state, 'pending');
    // The window is the session, not the gap-padded reserved range the constraint uses.
    assert.equal(entitlement.starts_at.toISOString(), START);
    assert.equal(entitlement.ends_at.toISOString(), END);

    const { rows: work } = await db.query(
      'SELECT kind, due_at, done_at FROM due_work WHERE booking_id = $1 ORDER BY kind',
      [hold.bookingId],
    );
    // ORDER BY on an enum column sorts by declaration order, not alphabetically, which
    // for due_work_kind happens to be lifecycle order.
    const kinds = work.map((w) => (w as { kind: string }).kind);
    assert.deepEqual(kinds, ['hold_expiry', 'window_open', 'window_close']);

    const byKind = Object.fromEntries(
      work.map((w) => [(w as { kind: string }).kind, w as { due_at: Date; done_at: Date | null }]),
    );
    assert.ok(byKind['hold_expiry']?.done_at, 'the expiry is retired: it can no longer fire');
    assert.equal(byKind['window_open']?.due_at.toISOString(), START);
    assert.equal(byKind['window_close']?.due_at.toISOString(), END);
  });

  test('the sweeper leaves a paid booking alone even with a stale expiry row', async () => {
    const hold = await createHold(db, new FakePaymentProvider({ now: NOW }), INPUT, NOW);
    await handleWebhook(db, verifier, paidEvent(hold), SIG, NOW);

    // Un-retire the expiry, which is the state a webhook landing mid-sweep would leave.
    await db.query(
      `UPDATE due_work SET done_at = NULL WHERE booking_id = $1 AND kind = 'hold_expiry'`,
      [hold.bookingId],
    );
    const outcomes = await sweepDueWork(db, null, new Date(hold.holdExpiresAt.getTime() + 1000));

    assert.equal(outcomes[0]?.result, 'superseded');
    assert.deepEqual(await stateOf(hold.bookingId), { state: 'paid', holds_slot: true });
  });
});

describe('webhook redelivery against the database', () => {
  test('the same event twice grants one entitlement', async () => {
    const hold = await createHold(db, new FakePaymentProvider({ now: NOW }), INPUT, NOW);
    const body = paidEvent(hold);

    const first = await handleWebhook(db, verifier, body, SIG, NOW);
    const second = await handleWebhook(db, verifier, body, SIG, NOW);

    assert.equal(outcomeOf(first.body), 'paid');
    assert.equal(outcomeOf(second.body), 'duplicate');
    assert.equal(await scalar('SELECT count(*)::int AS n FROM entitlements'), 1);
    assert.equal(await scalar('SELECT count(*)::int AS n FROM processed_events'), 1);
  });

  test('a crash mid-handler leaves no dedupe row, so the retry really retries', async () => {
    const hold = await createHold(db, new FakePaymentProvider({ now: NOW }), INPUT, NOW);
    const body = paidEvent(hold);

    // The event id is recorded in the same transaction as the work. If it were not, this
    // crash would mark the event processed and Stripe's redelivery would be deduped away,
    // leaving a paid booking stuck in pending_payment forever.
    await assert.rejects(
      () => handleWebhook(failingOnce('INSERT INTO entitlements'), verifier, body, SIG, NOW),
      /simulated crash/,
    );

    assert.equal(await scalar('SELECT count(*)::int AS n FROM processed_events'), 0);
    assert.equal((await stateOf(hold.bookingId)).state, 'pending_payment');

    const retry = await handleWebhook(db, verifier, body, SIG, NOW);
    assert.equal(outcomeOf(retry.body), 'paid');
    assert.equal((await stateOf(hold.bookingId)).state, 'paid');
  });
});

describe('a payment that lands after the hold expired', () => {
  test('the slot is reclaimed when nobody else took it', async () => {
    const hold = await createHold(db, new FakePaymentProvider({ now: NOW }), INPUT, NOW);
    const afterExpiry = new Date(hold.holdExpiresAt.getTime() + 1000);
    assert.equal((await sweepDueWork(db, null, afterExpiry))[0]?.result, 'released');
    assert.deepEqual(await stateOf(hold.bookingId), {
      state: 'expired_hold', holds_slot: false,
    });

    const result = await handleWebhook(db, verifier, paidEvent(hold), SIG, afterExpiry);

    assert.equal(outcomeOf(result.body), 'paid_after_expiry');
    assert.deepEqual(await stateOf(hold.bookingId), { state: 'paid', holds_slot: true });
    assert.equal(await scalar('SELECT count(*)::int AS n FROM entitlements'), 1);
    assert.equal(await scalar('SELECT count(*)::int AS n FROM money_events'), 0);
  });

  test('the exclusion constraint is what refuses a resold hour', async () => {
    const first = await createHold(db, new FakePaymentProvider({ now: NOW }), INPUT, NOW);
    const afterExpiry = new Date(first.holdExpiresAt.getTime() + 1000);
    await sweepDueWork(db, null, afterExpiry);

    // The hour went back on sale and a second student bought it.
    const second = await createHold(
      db, new FakePaymentProvider({ now: NOW }), { ...INPUT, studentEmail: 'other@example.com' }, afterExpiry,
    );

    // Now the first student's payment arrives.
    const result = await handleWebhook(db, verifier, paidEvent(first), SIG, afterExpiry);

    assert.equal(outcomeOf(result.body), 'payment_orphaned');
    assert.deepEqual(await stateOf(first.bookingId), {
      state: 'payment_orphaned', holds_slot: false,
    });
    assert.deepEqual(
      await stateOf(second.bookingId),
      { state: 'pending_payment', holds_slot: true },
      'the student who actually holds the hour keeps it',
    );

    const { rows } = await db.query(
      'SELECT kind, amount_cents, note FROM money_events WHERE booking_id = $1',
      [first.bookingId],
    );
    const owed = rows[0] as { kind: string; amount_cents: number; note: string };
    assert.equal(owed.kind, 'manual_refund_owed', 'Alex has to refund this by hand');
    assert.equal(owed.amount_cents, 4000);
    assert.match(owed.note, /resold/);

    assert.equal(
      await scalar('SELECT count(*)::int AS n FROM entitlements'), 0,
      'an orphaned payment grants no access',
    );
  });
});
