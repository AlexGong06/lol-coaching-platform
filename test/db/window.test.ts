// The window handlers against a real PostgreSQL, from a real paid booking.
//
// The unit tests already cover which outcome each situation produces: decideInviteMaxAge
// and resolveWindowEnd are pure and exhaustively tested. What only the database can
// decide is whether the writes land together. Three of these matter more than the rest:
//
//   - a provider that refuses leaves NOTHING written and the work row still queued,
//     so the window can still be served on the next pass
//   - a provider that refuses the DELETE still lets the booking close and still records
//     the refund that is owed, because the code has already expired by itself
//   - a second pass over a resolved booking writes no second refund row
//
// Needs DATABASE_URL, read from .env by `npm run test:db`. See test/db/schema.test.ts
// for how to get one.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHold, type Hold, type HoldInput } from '../../src/booking.ts';
import { handleWebhook } from '../../src/api/webhook.ts';
import { sweepDueWork, type SweepOutcome } from '../../src/worker/sweep.ts';
import { FakePaymentProvider, FakeWebhookVerifier, paymentEvent } from '../support/fake-payments.ts';
import { FakeInviteProvider, type FakeInviteOptions } from '../support/fake-invites.ts';

const url = process.env.DATABASE_URL;
const db = new pg.Client({ connectionString: url });

// Friday 2026-11-20. Alex is open 18:00-22:00 Chicago; the first sellable hour is
// 2026-11-21T00:00Z, so the window under test is 00:00Z to 01:00Z.
const NOW = new Date('2026-11-20T12:00:00Z');
const START = new Date('2026-11-21T00:00:00.000Z');
const END = new Date('2026-11-21T01:00:00.000Z');
const LIVE_COACHING_CENTS = 4000;
const DISCORD_ID = '123456789012345678';

const INPUT: HoldInput = {
  sku: 'live_coaching',
  start: START.toISOString(),
  studentDiscordId: DISCORD_ID,
  studentEmail: 'student@example.com',
  riotId: 'Faker#KR1',
  studentTz: 'America/New_York',
};

const verifier = new FakeWebhookVerifier();
const at = (ms: number) => new Date(START.getTime() + ms);
const invitesAt = (now: Date, options: FakeInviteOptions = {}) =>
  new FakeInviteProvider({ now, ...options });

/** A booking that has been paid for: entitlement pending, both window rows queued. */
async function paidBooking(): Promise<Hold> {
  const hold = await createHold(db, new FakePaymentProvider({ now: NOW }), INPUT, NOW);
  const event = JSON.stringify(
    paymentEvent({ sessionId: hold.sessionId, bookingId: hold.bookingId }),
  );
  const result = await handleWebhook(db, verifier, event, FakeWebhookVerifier.VALID_SIGNATURE, NOW);
  assert.equal(result.status, 200, 'the fixture must start from a genuinely paid booking');
  return hold;
}

async function states(bookingId: string) {
  const { rows } = await db.query(
    `SELECT b.state AS booking, e.state AS entitlement, r.holds_slot
       FROM bookings b
       JOIN reservations r ON r.id = b.reservation_id
       JOIN entitlements e ON e.booking_id = b.id
      WHERE b.id = $1`,
    [bookingId],
  );
  return rows[0] as { booking: string; entitlement: string; holds_slot: boolean };
}

async function invitesOf(bookingId: string) {
  const { rows } = await db.query(
    `SELECT ai.code, ai.state::text AS state, ai.max_age_seconds, ai.expires_at
       FROM access_invites ai
       JOIN entitlements e ON e.id = ai.entitlement_id
      WHERE e.booking_id = $1`,
    [bookingId],
  );
  return rows as { code: string; state: string; max_age_seconds: number; expires_at: Date }[];
}

async function rowsOf(table: string, bookingId: string): Promise<Record<string, unknown>[]> {
  const sql =
    table === 'member_cleanup'
      ? `SELECT mc.* FROM member_cleanup mc
           JOIN entitlements e ON e.id = mc.entitlement_id WHERE e.booking_id = $1`
      : `SELECT * FROM ${table} WHERE booking_id = $1`;
  const { rows } = await db.query(sql, [bookingId]);
  return rows as Record<string, unknown>[];
}

async function workRow(bookingId: string, kind: string) {
  const { rows } = await db.query(
    'SELECT done_at, attempts, last_error FROM due_work WHERE booking_id = $1 AND kind = $2',
    [bookingId, kind],
  );
  return rows[0] as { done_at: Date | null; attempts: number; last_error: string | null };
}

/** Put a finished work row back on the queue, to prove a second pass is harmless. */
async function requeue(bookingId: string, kind: string): Promise<void> {
  await db.query(
    'UPDATE due_work SET done_at = NULL WHERE booking_id = $1 AND kind = $2',
    [bookingId, kind],
  );
}

const resultsOf = (outcomes: SweepOutcome[]) => outcomes.map((o) => `${o.kind}:${o.result}`);

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
  // CASCADE reaches entitlements, access_invites, member_cleanup, money_events and
  // due_work through their foreign keys.
  await db.query('TRUNCATE reservations, availability_rules, processed_events CASCADE');
  await db.query(
    `INSERT INTO availability_rules (weekday, start_local, end_local, tz)
     VALUES (5, '18:00', '22:00', 'America/Chicago')`,
  );
});

describe('window_open', () => {
  test('issues one code and opens the window', async () => {
    const hold = await paidBooking();
    const invites = invitesAt(START);
    const outcomes = await sweepDueWork(db, invites, START);

    assert.deepEqual(resultsOf(outcomes), ['window_open:opened']);
    assert.deepEqual(await states(hold.bookingId), {
      booking: 'active', entitlement: 'open', holds_slot: true,
    });

    const invited = await invitesOf(hold.bookingId);
    assert.equal(invited.length, 1);
    assert.equal(invited[0]?.state, 'issued');
    assert.equal(invited[0]?.max_age_seconds, 3600, 'a one-hour window is a one-hour code');
    assert.equal(invited[0]?.expires_at.toISOString(), END.toISOString());
    assert.equal((await workRow(hold.bookingId, 'window_open')).done_at === null, false);
  });

  test('the audit reason names the booking, so a stray code is traceable', async () => {
    const hold = await paidBooking();
    const invites = invitesAt(START);
    await sweepDueWork(db, invites, START);
    assert.match(invites.created[0]?.reason ?? '', new RegExp(`booking ${hold.bookingId}\\b`));
  });

  test('a late pass mints only the time that is left, never the full duration', async () => {
    // The invariant that makes a crash-orphaned code safe: it dies with its window.
    const hold = await paidBooking();
    const tenPast = at(10 * 60_000);
    await sweepDueWork(db, invitesAt(tenPast), tenPast);
    const invited = await invitesOf(hold.bookingId);
    assert.equal(invited[0]?.max_age_seconds, 3000);
    assert.equal(invited[0]?.expires_at.toISOString(), END.toISOString());
  });

  test('a pass after the window ended mints nothing and leaves the states alone', async () => {
    const hold = await paidBooking();
    const invites = invitesAt(END);
    // Only window_open is due at exactly END... window_close is too, so run the open
    // row by itself with a batch of one.
    const outcomes = await sweepDueWork(db, invites, END, 1);

    assert.deepEqual(resultsOf(outcomes), ['window_open:window_over']);
    assert.deepEqual(invites.created, [], 'max_age would have to be 0, which never expires');
    assert.deepEqual(await states(hold.bookingId), {
      // Exactly what resolveWindowEnd reads as "the poller missed window start".
      booking: 'paid', entitlement: 'pending', holds_slot: true,
    });
    assert.equal(await (async () => (await invitesOf(hold.bookingId)).length)(), 0);
  });

  test('a refusal writes nothing and leaves the work queued for the next pass', async () => {
    const hold = await paidBooking();
    const invites = invitesAt(START, { failCreateWith: 'Discord is down' });
    const outcomes = await sweepDueWork(db, invites, START, 1);

    assert.deepEqual(resultsOf(outcomes), ['window_open:failed']);
    assert.deepEqual(await states(hold.bookingId), {
      booking: 'paid', entitlement: 'pending', holds_slot: true,
    });
    assert.equal((await invitesOf(hold.bookingId)).length, 0);

    const work = await workRow(hold.bookingId, 'window_open');
    assert.equal(work.done_at, null, 'a window that was never served must stay queued');
    assert.equal(work.attempts, 1);
    assert.match(work.last_error ?? '', /Discord is down/);
  });

  test('with no token configured the row stays queued, naming what is missing', async () => {
    const hold = await paidBooking();
    const outcomes = await sweepDueWork(db, null, START, 1);
    assert.deepEqual(resultsOf(outcomes), ['window_open:failed']);
    const work = await workRow(hold.bookingId, 'window_open');
    assert.equal(work.done_at, null);
    assert.match(work.last_error ?? '', /DISCORD_BOT_TOKEN/);
  });

  test('a cancelled booking is never reopened', async () => {
    const hold = await paidBooking();
    await db.query(`UPDATE bookings SET state = 'cancelled' WHERE id = $1`, [hold.bookingId]);
    const invites = invitesAt(START);
    const outcomes = await sweepDueWork(db, invites, START, 1);

    assert.deepEqual(resultsOf(outcomes), ['window_open:superseded']);
    assert.equal(outcomes[0]?.note, 'booking is cancelled');
    assert.deepEqual(invites.created, []);
  });

  test('a second pass over an open window issues no second code', async () => {
    // One code per booking, ever. A reissue would admit a fresh stranger, because
    // Discord deletes a used invite and a disappeared code is indistinguishable from
    // one that was never used.
    const hold = await paidBooking();
    await sweepDueWork(db, invitesAt(START), START, 1);
    await requeue(hold.bookingId, 'window_open');

    const second = invitesAt(START);
    const outcomes = await sweepDueWork(db, second, START, 1);
    assert.deepEqual(resultsOf(outcomes), ['window_open:superseded']);
    assert.deepEqual(second.created, []);
    assert.equal((await invitesOf(hold.bookingId)).length, 1);
  });

  test("Discord's reported expiry is recorded as given, not clamped to the window", async () => {
    // Clock skew is real and this row must say when the code actually dies. The delete
    // at window_close is what enforces the boundary, not a prettier number here.
    const hold = await paidBooking();
    await sweepDueWork(db, invitesAt(START, { skewSeconds: 20 }), START, 1);
    const invited = await invitesOf(hold.bookingId);
    assert.equal(invited[0]?.expires_at.toISOString(), new Date(END.getTime() + 20_000).toISOString());
  });
});

describe('window_close', () => {
  test('a delivered session completes, owes nothing, and queues the cleanup', async () => {
    const hold = await paidBooking();
    await sweepDueWork(db, invitesAt(START), START, 1);

    const invites = invitesAt(END);
    const outcomes = await sweepDueWork(db, invites, END);
    assert.deepEqual(resultsOf(outcomes), ['window_close:closed']);
    assert.equal(outcomes[0]?.note, 'invite expired');
    assert.deepEqual(await states(hold.bookingId), {
      booking: 'completed',
      entitlement: 'closed',
      // The hour stays occupied: a finished session keeps the record that it was sold.
      holds_slot: true,
    });

    assert.deepEqual(await rowsOf('money_events', hold.bookingId), [], 'nothing is owed');
    const cleanup = await rowsOf('member_cleanup', hold.bookingId);
    assert.equal(cleanup.length, 1);
    assert.equal(cleanup[0]?.['discord_id'], DISCORD_ID);
    assert.equal(cleanup[0]?.['state'], 'queued');

    assert.equal((await invitesOf(hold.bookingId))[0]?.state, 'gone');
    assert.deepEqual(
      invites.deleted, [],
      'the recorded expiry had passed, so there was no reason to call Discord at all',
    );
  });

  test('only skew puts a call to Discord on the close path', async () => {
    // Discord's clock ran 20s ahead when the code was minted, so our own row says it
    // outlives the window. This is the one case where deleting is worth a request.
    const hold = await paidBooking();
    await sweepDueWork(db, invitesAt(START, { skewSeconds: 20 }), START, 1);

    const invites = invitesAt(END);
    const outcomes = await sweepDueWork(db, invites, END);
    assert.equal(outcomes[0]?.note, 'invite deleted');
    assert.equal(invites.deleted.length, 1);
    assert.equal((await invitesOf(hold.bookingId))[0]?.state, 'deleted');
  });

  test('an unconfirmed removal leaves the row saying the code is still live', async () => {
    // What the real API answers with only Create Instant Invite: "Unknown Invite",
    // which Discord also returns for a code it simply will not let this bot delete.
    // Recording that as removed would be a lie in the one case it matters.
    const hold = await paidBooking();
    await sweepDueWork(db, invitesAt(START, { skewSeconds: 20 }), START, 1);

    const outcomes = await sweepDueWork(db, invitesAt(END, { deleteOutcome: 'unknown' }), END);
    assert.deepEqual(resultsOf(outcomes), ['window_close:closed']);
    assert.equal(outcomes[0]?.note, 'invite unknown');
    assert.equal((await invitesOf(hold.bookingId))[0]?.state, 'issued');
    assert.equal((await states(hold.bookingId)).booking, 'completed');
  });

  test('a window that never opened owes a refund and queues no cleanup', async () => {
    const hold = await paidBooking();
    const invites = invitesAt(END);
    // window_open is never run: the only platform-failure path in the system.
    await db.query(
      `UPDATE due_work SET done_at = $2 WHERE booking_id = $1 AND kind = 'window_open'`,
      [hold.bookingId, END.toISOString()],
    );

    const outcomes = await sweepDueWork(db, invites, END);
    assert.deepEqual(resultsOf(outcomes), ['window_close:unfulfilled']);
    assert.deepEqual(await states(hold.bookingId), {
      booking: 'completed_unfulfilled', entitlement: 'expired_unfulfilled', holds_slot: true,
    });

    const owed = await rowsOf('money_events', hold.bookingId);
    assert.equal(owed.length, 1);
    assert.equal(owed[0]?.['kind'], 'manual_refund_owed');
    assert.equal(owed[0]?.['amount_cents'], LIVE_COACHING_CENTS);

    assert.deepEqual(
      await rowsOf('member_cleanup', hold.bookingId), [],
      'no code existed, so nobody can have got in',
    );
    assert.deepEqual(invites.deleted, [], 'there was nothing to delete');
  });

  test('a refused delete still closes the booking and still queues the cleanup', async () => {
    // Every code expires at or before its own window ends, so by the time this runs the
    // delete is belt and braces and a refusal is cosmetic. It must not be able to hold
    // the booking open or lose the cleanup obligation.
    //
    // There is no version of this test that also owes a refund: an issued code IS the
    // delivery, so resolveWindowEnd never pairs one with manual_refund_owed. An earlier
    // draft tried to force that pairing by hand and IllegalTransition refused it, which
    // is the state machine doing its job.
    const hold = await paidBooking();
    await sweepDueWork(db, invitesAt(START, { skewSeconds: 20 }), START, 1);

    const outcomes = await sweepDueWork(
      db, invitesAt(END, { failDeleteWith: 'Discord is down' }), END,
    );
    assert.deepEqual(resultsOf(outcomes), ['window_close:closed']);
    assert.equal(outcomes[0]?.note, 'invite failed');
    assert.deepEqual(await states(hold.bookingId), {
      booking: 'completed', entitlement: 'closed', holds_slot: true,
    });
    assert.equal((await rowsOf('member_cleanup', hold.bookingId)).length, 1);
    assert.equal(
      (await invitesOf(hold.bookingId))[0]?.state, 'issued',
      'recorded as still live, because as far as we know it is',
    );
  });

  test('a second pass writes no second refund and no second cleanup row', async () => {
    const hold = await paidBooking();
    await db.query(
      `UPDATE due_work SET done_at = $2 WHERE booking_id = $1 AND kind = 'window_open'`,
      [hold.bookingId, END.toISOString()],
    );
    await sweepDueWork(db, invitesAt(END), END);
    await requeue(hold.bookingId, 'window_close');

    const outcomes = await sweepDueWork(db, invitesAt(END), END);
    assert.deepEqual(resultsOf(outcomes), ['window_close:superseded']);
    assert.match(outcomes[0]?.note ?? '', /already terminal/);
    assert.equal((await rowsOf('money_events', hold.bookingId)).length, 1);
  });
});

describe('a whole session, one pass', () => {
  test('open then close, in due_at order, from paid to completed', async () => {
    // Both rows are due, so this also proves ORDER BY due_at: closing before opening
    // would resolve the session as unfulfilled and owe a refund on a delivered hour.
    const hold = await paidBooking();
    const invites = invitesAt(END);
    const outcomes = await sweepDueWork(db, invites, new Date(END.getTime() + 60_000));

    assert.deepEqual(resultsOf(outcomes), ['window_open:window_over', 'window_close:unfulfilled']);
    assert.equal((await states(hold.bookingId)).booking, 'completed_unfulfilled');
    assert.equal((await rowsOf('money_events', hold.bookingId)).length, 1);
  });

  test('served on time, both rows run and the booking completes', async () => {
    const hold = await paidBooking();
    await sweepDueWork(db, invitesAt(START), START, 1);
    const outcomes = await sweepDueWork(db, invitesAt(END), END);

    assert.deepEqual(resultsOf(outcomes), ['window_close:closed']);
    assert.deepEqual(await states(hold.bookingId), {
      booking: 'completed', entitlement: 'closed', holds_slot: true,
    });
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM due_work WHERE booking_id = $1 AND done_at IS NULL',
      [hold.bookingId],
    );
    assert.equal((rows[0] as { n: number }).n, 0, 'nothing left queued for a finished session');
  });
});
