// POST /api/stripe/webhook
//
// How this system learns that money moved. The student pays on Stripe's own domain, so
// nothing on the payment path passes through this server: the success redirect is a
// browser navigation that can be typed by hand, closed before it fires, or lost to a
// dropped connection. Treating it as proof of payment would mean free sessions one URL
// away and paying students stranded by bad wifi. Payment state arrives here instead,
// server to server, out of band from the student entirely.
//
// The handler never imports Stripe. It takes a WebhookVerifier and acts on the narrow
// PaymentEvent that comes back, so every transition below is testable with a plain
// object. src/stripe/verifier.ts is the only thing that knows about HMACs.
//
// In a Next.js route the raw body matters:
//
//   export async function POST(request: Request) {
//     const raw = await request.text();                 // NOT request.json()
//     const signature = request.headers.get('stripe-signature') ?? '';
//     const result = await handleWebhook(db, verifier, raw, signature, new Date());
//     return Response.json(result.body, { status: result.status });
//   }

import type { Queryable } from '../db/queries.ts';
import {
  WebhookVerificationError,
  type PaymentEvent,
  type WebhookVerifier,
} from '../payments.ts';
import { bookingTransition, type BookingState } from '../states.ts';
export type { ApiResult } from './result.ts';
import type { ApiResult } from './result.ts';

/**
 * Everything else is acknowledged and dropped. Returning a non-2xx for an event we do
 * not handle would make Stripe retry it for days.
 *
 * `checkout.session.expired` is deliberately absent: the hold sweeper already releases
 * lapsed holds on our own clock, and it stays authoritative so the release does not
 * depend on a webhook arriving. `checkout.session.async_payment_failed` is absent for
 * the same reason, since the hold simply lapses.
 *
 * `async_payment_succeeded` is here because a delayed payment method (a bank debit, say)
 * completes its session with payment_status unpaid and settles hours or days later on
 * that second event. Without it such a booking would sit in pending_payment until the
 * sweeper released the slot, and the money would arrive with nothing to apply it to.
 * Note that a 31-minute hold cannot survive a payment method that takes days, so the
 * real fix is to leave delayed methods switched off for this product; this is the net.
 */
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
] as const;

/** States in which the payment has already been recorded, so a replay changes nothing. */
const ALREADY_PAID: readonly BookingState[] = [
  'paid',
  'active',
  'completed',
  'completed_unfulfilled',
];

export type WebhookOutcome =
  /** The normal path: a hold that was still live is now paid for. */
  | 'paid'
  /** Paid in the last seconds before expiry; the slot was reclaimed successfully. */
  | 'paid_after_expiry'
  /** Paid, but the hour had already been sold to someone else. Alex owes a refund. */
  | 'payment_orphaned'
  /** A replay of an event already applied. */
  | 'already_paid'
  /** A redelivery of an event id already recorded. */
  | 'duplicate'
  /** A type this handler does not act on. */
  | 'ignored'
  /** The session is not attached to any booking here. */
  | 'unknown_session'
  /** Money arrived in a situation only a human should resolve. */
  | 'needs_review';

interface BookingRow {
  id: string;
  state: BookingState;
  reservation_id: string;
  starts_at: Date;
  ends_at: Date;
}

const ok = (outcome: WebhookOutcome, extra: Record<string, unknown> = {}): ApiResult => ({
  // Always 2xx once the signature verifies, including for cases a human must look at.
  // A non-2xx only buys an identical redelivery an hour later.
  status: 200,
  body: { received: true, outcome, ...extra },
});

function isOverlapViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23P01' && e.constraint === 'reservations_no_overlap';
}

async function rollback(db: Queryable): Promise<void> {
  try {
    await db.query('ROLLBACK');
  } catch {
    /* ignore: never mask the original error */
  }
}

export async function handleWebhook(
  db: Queryable,
  verifier: WebhookVerifier,
  rawBody: string,
  signature: string,
  now: Date,
): Promise<ApiResult> {
  let event: PaymentEvent;
  try {
    event = verifier.verify(rawBody, signature);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      // Nothing is read out of the body before this point. An unverified request is not
      // evidence of anything, including of which booking it claims to be about.
      return { status: 400, body: { error: { code: 'bad_signature', message: err.message } } };
    }
    throw err;
  }

  if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(event.type)) {
    return ok('ignored', { type: event.type });
  }

  await db.query('BEGIN');
  try {
    // The dedupe insert is in the SAME transaction as the state change, which is the
    // whole point of it. Recording the event first and committing separately would mean
    // a crash mid-handler leaves the event marked processed with the work undone, and
    // Stripe's redelivery then skips it.
    const { rows: fresh } = await db.query(
      `INSERT INTO processed_events (stripe_event_id) VALUES ($1)
       ON CONFLICT DO NOTHING
         RETURNING stripe_event_id`,
      [event.id],
    );
    if (fresh.length === 0) {
      await db.query('COMMIT');
      return ok('duplicate', { eventId: event.id });
    }

    if (event.sessionId === null) {
      await db.query('COMMIT');
      return ok('needs_review', { reason: 'event carries no session id' });
    }

    // A session can complete without the money being settled, for payment methods that
    // clear asynchronously. Only `paid` is paid.
    if (event.paymentStatus !== 'paid') {
      await db.query('COMMIT');
      return ok('needs_review', {
        reason: `payment_status is ${String(event.paymentStatus)}, not paid`,
      });
    }

    const { rows } = await db.query(
      `SELECT b.id, b.state, b.reservation_id, r.starts_at, r.ends_at
         FROM bookings b
         JOIN reservations r ON r.id = b.reservation_id
        WHERE b.stripe_session_id = $1
          FOR UPDATE OF b`,
      [event.sessionId],
    );
    const booking = rows[0] as BookingRow | undefined;

    if (booking === undefined) {
      // Reachable if the provider created a session and our own transaction then failed
      // to commit: Stripe has a payable session for a booking that does not exist. The
      // student never received that URL, so this is close to unreachable in practice,
      // and it cannot be recorded in money_events, whose booking_id is NOT NULL.
      await db.query('COMMIT');
      return ok('unknown_session', { sessionId: event.sessionId });
    }

    // Guard against a metadata/session mismatch rather than trusting either alone.
    // metadata is a blob we control, so a disagreement means something is wrong enough
    // that no money should move on it.
    if (event.bookingId !== null && event.bookingId !== booking.id) {
      await db.query('COMMIT');
      return ok('needs_review', {
        reason: `session ${event.sessionId} names booking ${event.bookingId} but is attached to ${booking.id}`,
      });
    }

    if (ALREADY_PAID.includes(booking.state)) {
      await db.query('COMMIT');
      return ok('already_paid', { bookingId: booking.id, state: booking.state });
    }

    if (booking.state === 'cancelled' || booking.state === 'payment_orphaned') {
      // No edge out of either state leads to `paid`, and inventing one would resurrect a
      // booking nobody intends to deliver. Recorded as owed and left alone.
      await recordRefundOwed(db, booking.id, event, `paid while ${booking.state}`);
      await db.query('COMMIT');
      return ok('needs_review', { bookingId: booking.id, state: booking.state });
    }

    // Reclaim the slot. For a live hold this is a no-op, since holds_slot is already
    // true. For one the sweeper released seconds ago it is the whole question, and the
    // exclusion constraint answers it: if someone else booked the hour in between, the
    // UPDATE cannot succeed.
    const reclaimed = await reclaimSlot(db, booking.reservation_id);
    const wasExpired = booking.state === 'expired_hold';

    if (!reclaimed) {
      const next = bookingTransition(booking.state, 'payment_orphaned', 'webhook_handler');
      await db.query('UPDATE bookings SET state = $2, updated_at = $3 WHERE id = $1', [
        booking.id,
        next,
        now.toISOString(),
      ]);
      await recordRefundOwed(db, booking.id, event, 'paid after the slot was resold');
      await db.query('COMMIT');
      return ok('payment_orphaned', { bookingId: booking.id });
    }

    const next = bookingTransition(booking.state, 'paid', 'webhook_handler');
    await db.query('UPDATE bookings SET state = $2, updated_at = $3 WHERE id = $1', [
      booking.id,
      next,
      now.toISOString(),
    ]);

    // The access window is the booking itself, per the SKU table in the design doc: all
    // three SKUs differ only in duration. These are the session's own bounds, not the
    // padded `reserved` range, which exists to keep sessions apart and is not sold.
    await db.query(
      `INSERT INTO entitlements (booking_id, starts_at, ends_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [booking.id, booking.starts_at.toISOString(), booking.ends_at.toISOString()],
    );

    // Queued now rather than discovered later by scanning bookings. The sweeper does not
    // handle these kinds yet, which is why they are left queued rather than claimed.
    await db.query(
      `INSERT INTO due_work (kind, booking_id, due_at)
            VALUES ('window_open', $1, $2), ('window_close', $1, $3)
       ON CONFLICT DO NOTHING`,
      [booking.id, booking.starts_at.toISOString(), booking.ends_at.toISOString()],
    );

    // The hold can no longer lapse, so retire its expiry instead of leaving the sweeper
    // to claim it and discover it is superseded.
    await db.query(
      `UPDATE due_work SET done_at = $2
        WHERE booking_id = $1 AND kind = 'hold_expiry' AND done_at IS NULL`,
      [booking.id, now.toISOString()],
    );

    await db.query('COMMIT');
    return ok(wasExpired ? 'paid_after_expiry' : 'paid', { bookingId: booking.id });
  } catch (err) {
    // The processed_events row goes back with everything else, so Stripe's redelivery
    // gets a real second attempt rather than being deduped away. A 500 here is the
    // correct answer: it is what makes Stripe retry.
    await rollback(db);
    throw err;
  }
}

/** True if the slot is ours; false if the exclusion constraint says it is gone. */
async function reclaimSlot(db: Queryable, reservationId: string): Promise<boolean> {
  // A savepoint, because a constraint violation aborts the whole transaction otherwise
  // and the orphan path still has writing to do.
  await db.query('SAVEPOINT reclaim');
  try {
    await db.query('UPDATE reservations SET holds_slot = true WHERE id = $1', [reservationId]);
    await db.query('RELEASE SAVEPOINT reclaim');
    return true;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT reclaim');
    if (isOverlapViolation(err)) return false;
    throw err;
  }
}

/**
 * Append to the money ledger. Nothing in this system calls Stripe's refund API; this
 * row is what puts a red line in /ops for Alex to refund by hand.
 */
async function recordRefundOwed(
  db: Queryable,
  bookingId: string,
  event: PaymentEvent,
  note: string,
): Promise<void> {
  await db.query(
    `INSERT INTO money_events (booking_id, kind, amount_cents, stripe_event_id, note)
          VALUES ($1, 'manual_refund_owed', $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [bookingId, event.amountTotalCents, event.id, note],
  );
}
