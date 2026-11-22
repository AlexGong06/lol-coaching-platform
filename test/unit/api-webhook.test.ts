// POST /api/stripe/webhook, with the database and the signature check both faked.
//
// This endpoint is public, unauthenticated, called by someone else's server, retried on
// failure, and able to arrive out of order. Every test here is one of those properties.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhook } from '../../src/api/webhook.ts';
import type { BookingState } from '../../src/states.ts';
import { FakeWebhookVerifier, paymentEvent } from '../support/fake-payments.ts';

const NOW = new Date('2026-11-20T18:00:00Z');
const SIG = FakeWebhookVerifier.VALID_SIGNATURE;
const verifier = new FakeWebhookVerifier();

const SESSION_START = new Date('2026-11-21T00:00:00Z');
const SESSION_END = new Date('2026-11-21T01:00:00Z');

interface FakeDbOptions {
  /** The booking the session resolves to. `null` means no row matches. */
  booking?: { id: string; state: BookingState } | null;
  /** True when processed_events already holds this event id. */
  duplicate?: boolean;
  /** Thrown by the slot reclaim, to stand in for the hour having been resold. */
  reclaimError?: unknown;
}

function fakeDb(options: FakeDbOptions = {}) {
  // Whole statements, not first lines: half the assertions below look for text that
  // sits several lines into a query.
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    calls,
    /** Did any statement containing `needle` run? */
    ran(needle: string): boolean {
      return calls.some((c) => c.sql.includes(needle));
    },
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      calls.push(params === undefined ? { sql } : { sql, params });
      if (sql.includes('INSERT INTO processed_events')) {
        return { rows: options.duplicate ? [] : [{ stripe_event_id: 'evt' }] };
      }
      if (sql.includes('FROM bookings')) {
        const booking = options.booking;
        if (booking === null || booking === undefined) return { rows: [] };
        return {
          rows: [
            {
              id: booking.id,
              state: booking.state,
              reservation_id: '7',
              starts_at: SESSION_START,
              ends_at: SESSION_END,
            },
          ],
        };
      }
      if (sql.includes('UPDATE reservations') && options.reclaimError) throw options.reclaimError;
      return { rows: [] };
    },
  };
}

const resold = () =>
  Object.assign(new Error('conflicting key value violates exclusion constraint'), {
    code: '23P01',
    constraint: 'reservations_no_overlap',
  });

const outcomeOf = (body: unknown) => (body as { outcome: string }).outcome;

describe('webhook authenticity', () => {
  test('a forged signature is refused and nothing is read from the body', async () => {
    const db = fakeDb({ booking: { id: '22', state: 'pending_payment' } });
    const body = JSON.stringify(paymentEvent({ sessionId: 'cs_test_1' }));

    const result = await handleWebhook(db, verifier, body, 'not-the-signature', NOW);

    assert.equal(result.status, 400);
    assert.equal((result.body as { error: { code: string } }).error.code, 'bad_signature');
    assert.deepEqual(db.calls, [], 'an unverified request must not touch the database');
  });

  test('an event type this handler does not act on is acknowledged, not retried', async () => {
    // A non-2xx would have Stripe redelivering this for days.
    const db = fakeDb();
    const body = JSON.stringify(paymentEvent({ type: 'customer.created' }));
    const result = await handleWebhook(db, verifier, body, SIG, NOW);

    assert.equal(result.status, 200);
    assert.equal(outcomeOf(result.body), 'ignored');
    assert.deepEqual(db.calls, []);
  });
});

describe('webhook idempotency', () => {
  test('a redelivered event id changes nothing', async () => {
    const db = fakeDb({ duplicate: true, booking: { id: '22', state: 'pending_payment' } });
    const result = await handleWebhook(db, verifier, JSON.stringify(paymentEvent()), SIG, NOW);

    assert.equal(outcomeOf(result.body), 'duplicate');
    assert.ok(!db.ran('FROM bookings'), 'the booking is not even looked up');
    assert.ok(!db.ran('UPDATE bookings'));
  });

  test('a replay of a booking already paid is a no-op, not an illegal transition', async () => {
    // A distinct event id for a booking that has moved on: the state check, not the
    // dedupe table, is what catches this one.
    const db = fakeDb({ booking: { id: '22', state: 'active' } });
    const result = await handleWebhook(db, verifier, JSON.stringify(paymentEvent()), SIG, NOW);

    assert.equal(outcomeOf(result.body), 'already_paid');
    assert.ok(!db.ran('UPDATE bookings'));
    assert.ok(db.ran('COMMIT'));
  });
});

describe('webhook payments that need a human', () => {
  test('a session attached to no booking here is acknowledged and flagged', async () => {
    const db = fakeDb({ booking: null });
    const result = await handleWebhook(db, verifier, JSON.stringify(paymentEvent()), SIG, NOW);

    assert.equal(result.status, 200);
    assert.equal(outcomeOf(result.body), 'unknown_session');
  });

  test('a session whose payment has not settled does not mark the booking paid', async () => {
    const db = fakeDb({ booking: { id: '22', state: 'pending_payment' } });
    const body = JSON.stringify(paymentEvent({ paymentStatus: 'unpaid' }));
    const result = await handleWebhook(db, verifier, body, SIG, NOW);

    assert.equal(outcomeOf(result.body), 'needs_review');
    assert.ok(!db.ran('UPDATE bookings'));
  });

  test('metadata naming a different booking than the session stops the payment', async () => {
    const db = fakeDb({ booking: { id: '22', state: 'pending_payment' } });
    const body = JSON.stringify(paymentEvent({ bookingId: '99' }));
    const result = await handleWebhook(db, verifier, body, SIG, NOW);

    assert.equal(outcomeOf(result.body), 'needs_review');
    assert.ok(!db.ran('UPDATE bookings'), 'no money moves on a disagreement');
  });

  test('money arriving for a cancelled booking is recorded as owed, not applied', async () => {
    const db = fakeDb({ booking: { id: '22', state: 'cancelled' } });
    const result = await handleWebhook(db, verifier, JSON.stringify(paymentEvent()), SIG, NOW);

    assert.equal(outcomeOf(result.body), 'needs_review');
    assert.ok(db.ran('INSERT INTO money_events'), 'the ledger must record it');
    assert.ok(!db.ran('INSERT INTO entitlements'), 'a cancelled booking is not fulfilled');
  });
});

describe('webhook payment applied', () => {
  test('a live hold becomes paid, with its window and its due work', async () => {
    const db = fakeDb({ booking: { id: '22', state: 'pending_payment' } });
    const result = await handleWebhook(db, verifier, JSON.stringify(paymentEvent()), SIG, NOW);

    assert.equal(outcomeOf(result.body), 'paid');
    assert.ok(db.ran('INSERT INTO entitlements'));
    assert.ok(db.ran("VALUES ('window_open', $1, $2), ('window_close', $1, $3)"));
    assert.ok(db.ran('COMMIT'));

    // The entitlement window is the session itself, not the gap-padded reserved range.
    const entitlement = db.calls.find((c) => c.sql.includes('INSERT INTO entitlements'));
    assert.deepEqual(entitlement?.params, [
      '22', SESSION_START.toISOString(), SESSION_END.toISOString(),
    ]);
  });

  test('the lapsed expiry is retired so the sweeper never claims it', async () => {
    const db = fakeDb({ booking: { id: '22', state: 'pending_payment' } });
    await handleWebhook(db, verifier, JSON.stringify(paymentEvent()), SIG, NOW);
    assert.ok(db.ran("kind = 'hold_expiry' AND done_at IS NULL"));
  });

  test('a payment landing just after expiry reclaims the slot', async () => {
    const db = fakeDb({ booking: { id: '22', state: 'expired_hold' } });
    const result = await handleWebhook(db, verifier, JSON.stringify(paymentEvent()), SIG, NOW);

    assert.equal(outcomeOf(result.body), 'paid_after_expiry');
    assert.ok(db.ran('UPDATE reservations'), 'holds_slot has to go back to true');
    assert.ok(db.ran('INSERT INTO entitlements'));
  });

  test('a payment landing after the hour was resold is orphaned, not forced', async () => {
    const db = fakeDb({ booking: { id: '22', state: 'expired_hold' }, reclaimError: resold() });
    const result = await handleWebhook(db, verifier, JSON.stringify(paymentEvent()), SIG, NOW);

    assert.equal(outcomeOf(result.body), 'payment_orphaned');
    assert.ok(db.ran('ROLLBACK TO SAVEPOINT reclaim'), 'the conflict must not abort the rest');
    assert.ok(db.ran('INSERT INTO money_events'));
    assert.ok(!db.ran('INSERT INTO entitlements'), 'nothing was sold, so nothing is granted');
    assert.ok(db.ran('COMMIT'), 'the orphan record itself must commit');
  });
});

describe('delayed payment methods', () => {
  test('a session completing unpaid grants nothing, and the later event applies it', async () => {
    // A bank debit completes the session before the money arrives. Granting access on
    // the first event would give away a session that may never be paid for.
    const unpaid = fakeDb({ booking: { id: '22', state: 'pending_payment' } });
    const first = await handleWebhook(
      unpaid, verifier, JSON.stringify(paymentEvent({ paymentStatus: 'unpaid' })), SIG, NOW,
    );
    assert.equal(outcomeOf(first.body), 'needs_review');
    assert.ok(!unpaid.ran('INSERT INTO entitlements'));

    const settled = fakeDb({ booking: { id: '22', state: 'pending_payment' } });
    const second = await handleWebhook(
      settled,
      verifier,
      JSON.stringify(paymentEvent({ type: 'checkout.session.async_payment_succeeded' })),
      SIG,
      NOW,
    );
    assert.equal(outcomeOf(second.body), 'paid');
    assert.ok(settled.ran('INSERT INTO entitlements'));
  });
});
