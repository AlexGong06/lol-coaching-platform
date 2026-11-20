// The write path against a real PostgreSQL.
//
// These are the tests the PaymentProvider interface exists for. Every one of them turns
// on something only the database can decide: a rollback actually removing a row, the
// exclusion constraint refusing a concurrent insert, FOR UPDATE serializing a poller
// against a webhook, SKIP LOCKED keeping two pollers off one row.
//
// Needs DATABASE_URL, read from .env by `npm run test:db`. See test/db/schema.test.ts
// for how to get one.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHold, HoldError, type HoldInput } from '../../src/booking.ts';
import { handleAvailability } from '../../src/api/availability.ts';
import { sweepDueWork } from '../../src/worker/sweep.ts';
import type { CheckoutSession, CheckoutSessionInput, PaymentProvider } from '../../src/payments.ts';
import { FakePaymentProvider } from '../support/fake-payments.ts';

const url = process.env.DATABASE_URL;
// Three connections: the one under test, a competitor for the race tests, and a probe
// that can see what the other two are blocked on without being blocked itself.
const db = new pg.Client({ connectionString: url });
const rival = new pg.Client({ connectionString: url });
const probe = new pg.Client({ connectionString: url });

// Friday 2026-11-20. Alex is open 18:00-22:00 Chicago, which in November (CST) is
// 2026-11-21T00:00Z to 04:00Z.
const NOW = new Date('2026-11-20T12:00:00Z');
const START = '2026-11-21T00:00:00.000Z';
const WINDOW = { from: '2026-11-16T00:00:00Z', to: '2026-11-23T00:00:00Z' };

const INPUT: HoldInput = {
  sku: 'live_coaching',
  start: START,
  studentDiscordId: '123456789012345678',
  studentEmail: 'student@example.com',
  riotId: 'Faker#KR1',
  studentTz: 'America/New_York',
};

interface Body {
  days?: { slots: { start: string }[] }[];
}

async function offeredStarts(now = NOW): Promise<string[]> {
  const result = await handleAvailability(
    db, { sku: 'live_coaching', ...WINDOW, tz: 'America/New_York' }, now,
  );
  return (result.body as Body).days?.flatMap((d) => d.slots.map((s) => s.start)) ?? [];
}

async function count(table: string): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
  return (rows[0] as { n: number }).n;
}

/**
 * A provider that parks inside createCheckoutSession until released, leaving the hold
 * transaction open with its reservation inserted and uncommitted. That is the only
 * window in which a second student can lose the race, so it is the only way to test it.
 */
function gatedProvider() {
  let release: () => void = () => {};
  let signalEntered: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });

  const provider: PaymentProvider = {
    async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
      signalEntered();
      await gate;
      return {
        sessionId: `cs_gated_${input.bookingId}`,
        url: 'https://checkout.example/gated',
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      };
    },
  };
  return { provider, entered, release: () => release() };
}

/** Wait until some backend is blocked on a lock inside a statement matching `needle`. */
async function waitUntilBlocked(needle: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const { rows } = await probe.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE $1`,
      [`%${needle}%`],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`nothing ever blocked on ${needle}`);
}

// File-level, not per-suite: a describe's `after` runs before the next describe starts,
// so closing the connections there left the sweeper suite with three dead clients.
before(async () => {
  assert.ok(
    url,
    'DATABASE_URL is unset, and no .env was found for the test script to read.\n' +
      '  cp .env.example .env     (then `npm run db:up` if Postgres is not running)',
  );
  await Promise.all([db.connect(), rival.connect(), probe.connect()]);
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'due_work'`,
  );
  assert.equal(rows.length, 1, 'run `npm run migrate` first');
});

after(async () => {
  await Promise.all([db.end(), rival.end(), probe.end()]);
});

beforeEach(async () => {
  // reservations CASCADE reaches bookings, and bookings CASCADE reaches due_work.
  await db.query('TRUNCATE reservations, availability_rules CASCADE');
  await db.query(
    `INSERT INTO availability_rules (weekday, start_local, end_local, tz)
     VALUES (5, '18:00', '22:00', 'America/Chicago')`,
  );
});

describe('createHold against the database', () => {
  test('a hold reserves the slot, stores the session, and queues its own expiry', async () => {
    const provider = new FakePaymentProvider();
    const hold = await createHold(db, provider, INPUT, NOW);

    const { rows: bookings } = await db.query(
      `SELECT state, sku, price_cents, stripe_session_id, hold_expires_at, reservation_id
         FROM bookings WHERE id = $1`,
      [hold.bookingId],
    );
    const booking = bookings[0] as {
      state: string; sku: string; price_cents: number;
      stripe_session_id: string; hold_expires_at: Date; reservation_id: string;
    };
    assert.equal(booking.state, 'pending_payment');
    assert.equal(booking.sku, 'live_coaching');
    assert.equal(booking.price_cents, 4000);
    assert.equal(booking.stripe_session_id, provider.calls.length === 1 ? hold.sessionId : '');
    assert.equal(booking.reservation_id, hold.reservationId);

    const { rows: work } = await db.query(
      'SELECT kind, due_at, done_at FROM due_work WHERE booking_id = $1',
      [hold.bookingId],
    );
    assert.equal(work.length, 1, 'exactly one expiry is queued');
    const row = work[0] as { kind: string; due_at: Date; done_at: Date | null };
    assert.equal(row.kind, 'hold_expiry');
    assert.equal(row.done_at, null);
    assert.equal(
      row.due_at.toISOString(), booking.hold_expires_at.toISOString(),
      'the queued instant and the booking must agree, or the countdown lies',
    );
  });

  test('the reserved range carries the gap, so the next offer is 19:15', async () => {
    await createHold(db, new FakePaymentProvider(), INPUT, NOW);
    const offered = await offeredStarts();

    assert.ok(!offered.includes(START), 'the booked hour is gone');
    assert.ok(!offered.includes('2026-11-21T01:00:00.000Z'), '19:00 is inside the gap');
    assert.ok(offered.includes('2026-11-21T01:15:00.000Z'), '19:15 is the first instant free');
  });

  test('booking the same slot twice over sees a stale calendar, not a crash', async () => {
    await createHold(db, new FakePaymentProvider(), INPUT, NOW);
    // Sequential, so the first hold is committed and visible: this is the common case,
    // a student on a tab that was open when someone else booked.
    await assert.rejects(
      () => createHold(db, new FakePaymentProvider(), INPUT, NOW),
      (err: unknown) => err instanceof HoldError && err.code === 'not_offered',
    );
  });

  test('a provider failure leaves nothing behind and the slot is offered again', async () => {
    const provider = new FakePaymentProvider({ failWith: 'stripe unreachable' });
    await assert.rejects(
      () => createHold(db, provider, INPUT, NOW),
      (err: unknown) => err instanceof HoldError && err.code === 'provider_failed',
    );

    assert.equal(await count('reservations'), 0, 'the reservation must be rolled back');
    assert.equal(await count('bookings'), 0);
    assert.equal(await count('due_work'), 0);
    assert.ok(
      (await offeredStarts()).includes(START),
      'a failed payment attempt must not take the hour off sale',
    );
  });

  test('two students racing for one slot: one wins, the other gets slot_taken', async () => {
    const gated = gatedProvider();
    // The winner stops inside the provider call with its reservation inserted and its
    // transaction open.
    const winner = createHold(db, gated.provider, INPUT, NOW);
    await gated.entered;

    // The loser passes the offered check (nothing is committed yet) and then blocks on
    // the exclusion constraint against a row it cannot see.
    const loser = createHold(rival, new FakePaymentProvider(), INPUT, NOW);
    await waitUntilBlocked('INSERT INTO reservations');

    gated.release();
    const held = await winner;

    await assert.rejects(
      () => loser,
      (err: unknown) => {
        assert.ok(err instanceof HoldError);
        assert.equal(err.code, 'slot_taken', 'a genuine race must be distinguishable');
        return true;
      },
    );

    assert.equal(await count('reservations'), 1, 'exactly one reservation survives');
    assert.equal(await count('bookings'), 1);
    const { rows } = await db.query('SELECT id FROM bookings');
    assert.equal((rows[0] as { id: string }).id, held.bookingId);
  });
});

describe('the hold-expiry sweeper', () => {
  test('a lapsed hold is released and the hour goes back on sale', async () => {
    const hold = await createHold(db, new FakePaymentProvider(), INPUT, NOW);
    const after = new Date(hold.holdExpiresAt.getTime() + 1000);

    const outcomes = await sweepDueWork(db, after);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.result, 'released');

    const { rows } = await db.query(
      `SELECT b.state, r.holds_slot, w.done_at
         FROM bookings b
         JOIN reservations r ON r.id = b.reservation_id
         JOIN due_work w ON w.booking_id = b.id
        WHERE b.id = $1`,
      [hold.bookingId],
    );
    const row = rows[0] as { state: string; holds_slot: boolean; done_at: Date | null };
    assert.equal(row.state, 'expired_hold');
    assert.equal(row.holds_slot, false, 'the row stays, but stops occupying time');
    assert.ok(row.done_at, 'the work must be marked done');

    // `now` is still before the session, so the slot is bookable again.
    assert.ok((await offeredStarts()).includes(START));
  });

  test('a hold paid in the last second is not released', async () => {
    const hold = await createHold(db, new FakePaymentProvider(), INPUT, NOW);
    // Stands in for the webhook landing first. The sweeper must notice and stand down.
    await db.query(`UPDATE bookings SET state = 'paid' WHERE id = $1`, [hold.bookingId]);

    const outcomes = await sweepDueWork(db, new Date(hold.holdExpiresAt.getTime() + 1000));
    assert.equal(outcomes[0]?.result, 'superseded');

    const { rows } = await db.query(
      `SELECT b.state, r.holds_slot FROM bookings b
         JOIN reservations r ON r.id = b.reservation_id WHERE b.id = $1`,
      [hold.bookingId],
    );
    assert.deepEqual(rows[0], { state: 'paid', holds_slot: true });
    assert.ok(
      !(await offeredStarts()).includes(START),
      'a paid session must never be resold',
    );
  });

  test('work that is not due yet is left alone', async () => {
    const hold = await createHold(db, new FakePaymentProvider(), INPUT, NOW);
    const outcomes = await sweepDueWork(db, new Date(hold.holdExpiresAt.getTime() - 1000));
    assert.deepEqual(outcomes, []);
    const { rows } = await db.query('SELECT state FROM bookings WHERE id = $1', [hold.bookingId]);
    assert.equal((rows[0] as { state: string }).state, 'pending_payment');
  });

  test('work of a kind this poller cannot run is left queued, not marked done', async () => {
    const hold = await createHold(db, new FakePaymentProvider(), INPUT, NOW);
    await db.query(
      `INSERT INTO due_work (kind, booking_id, due_at) VALUES ('window_open', $1, $2)`,
      [hold.bookingId, NOW.toISOString()],
    );

    const outcomes = await sweepDueWork(db, NOW);
    assert.deepEqual(outcomes, [], 'hold_expiry is not due, window_open is not handled');

    const { rows } = await db.query(
      `SELECT done_at, attempts FROM due_work WHERE kind = 'window_open'`,
    );
    assert.deepEqual(rows[0], { done_at: null, attempts: 0 }, 'the backlog must survive');
  });

  test('a booking cannot be queued for the same expiry twice', async () => {
    const hold = await createHold(db, new FakePaymentProvider(), INPUT, NOW);
    await assert.rejects(
      () => db.query(
        `INSERT INTO due_work (kind, booking_id, due_at) VALUES ('hold_expiry', $1, now())`,
        [hold.bookingId],
      ),
      (err: unknown) => (err as { code?: string }).code === '23505',
    );
  });

  test('a second poller skips a row the first is already running', async () => {
    const hold = await createHold(db, new FakePaymentProvider(), INPUT, NOW);
    const after = new Date(hold.holdExpiresAt.getTime() + 1000);

    // Stand in for the first poller mid-handler: claimed, locked, not yet committed.
    await rival.query('BEGIN');
    await rival.query(
      `SELECT id FROM due_work WHERE done_at IS NULL AND due_at <= $1
         ORDER BY due_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [after.toISOString()],
    );

    try {
      const outcomes = await sweepDueWork(db, after);
      assert.deepEqual(outcomes, [], 'the row is locked, so this pass must find nothing');
      const { rows } = await db.query('SELECT state FROM bookings WHERE id = $1', [hold.bookingId]);
      assert.equal(
        (rows[0] as { state: string }).state, 'pending_payment',
        'the second poller must not have run the handler',
      );
    } finally {
      await rival.query('ROLLBACK');
    }
  });
});
