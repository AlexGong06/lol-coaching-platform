// The two handlers that run because a session's window started or ended.
//
// Both are thin. The decisions they carry out already live in pure functions that were
// written and tested first: decideInviteMaxAge (invite.ts) says whether a code may be
// minted and for how long, and resolveWindowEnd (fulfillment.ts) says what a finished
// window resolves to and whether money is owed. What is left here is the part that
// needs a database and a Discord call: reading the rows under lock, checking nothing
// has moved underneath, and writing the result.
//
// Both run inside the sweeper's transaction with the due_work row and the booking row
// locked, which is also what makes them safe against the webhook landing mid-flight.
//
// The network call inside that transaction is the known cost, the same one createHold
// pays for Stripe: a Discord round trip holds a connection and two row locks for its
// duration. Bounded at REQUEST_TIMEOUT_MS, and at one booking an hour it is not worth
// designing around. It becomes worth it if this ever runs at a rate where connections
// queue.

import type { Queryable } from '../db/queries.ts';
import { type DeleteOutcome, type InviteProvider, InviteProviderError } from '../access.ts';
import { decideInviteMaxAge } from '../invite.ts';
import { resolveWindowEnd } from '../fulfillment.ts';
import {
  type BookingState, type EntitlementState, bookingTransition, entitlementTransition,
} from '../states.ts';

/**
 * What happened to the code on the channel when the window closed.
 *
 *   none      no code was ever issued
 *   expired   our own recorded expiry had passed, so Discord was not asked
 *   deleted   the code was still live and Discord confirmed removing it
 *   unknown   Discord answered "Unknown Invite", which it also does when the bot may
 *             not delete; removal is therefore unconfirmed
 *   failed    Discord refused or could not be reached
 */
export type InviteRemoval = DeleteOutcome | 'none' | 'expired' | 'failed';

export type WindowOpenResult =
  | { result: 'opened'; entitlementId: string; expiresAt: Date }
  /** The pass ran after the window had already ended, so no code may be minted. */
  | { result: 'window_over' }
  | { result: 'superseded'; note: string };

export type WindowCloseResult =
  | {
      result: 'closed' | 'unfulfilled';
      booking: BookingState;
      entitlement: EntitlementState;
      manualRefundOwed: boolean;
      inviteRemoval: InviteRemoval;
    }
  | { result: 'superseded'; note: string };

interface WindowRow {
  state: BookingState;
  student_discord_id: string;
  price_cents: number;
  entitlement_id: string;
  entitlement_state: EntitlementState;
  ends_at: Date | string;
  invite_code: string | null;
  invite_state: string | null;
  invite_expires_at: Date | string | null;
}

const asDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

/**
 * Load the booking, its entitlement and its one invite, locking the two rows this
 * handler may write. The invite row is left unlocked: it is created once and only ever
 * read here, and `access_invites.entitlement_id` is UNIQUE, so the LEFT JOIN cannot
 * multiply the booking row.
 */
async function loadUnderLock(db: Queryable, bookingId: string): Promise<WindowRow> {
  const { rows } = await db.query(
    `SELECT b.state, b.student_discord_id, b.price_cents,
            e.id AS entitlement_id, e.state AS entitlement_state, e.ends_at,
            ai.code AS invite_code, ai.state::text AS invite_state,
            ai.expires_at AS invite_expires_at
       FROM bookings b
       JOIN entitlements e ON e.booking_id = b.id
       LEFT JOIN access_invites ai ON ai.entitlement_id = e.id
      WHERE b.id = $1
        FOR UPDATE OF b, e`,
    [bookingId],
  );

  const row = rows[0] as WindowRow | undefined;
  // The webhook creates the entitlement in the same transaction that queues this work,
  // so a window row without one is a broken invariant, not a race. Failing loudly
  // leaves the work queued rather than discharging it as "nothing to do".
  if (row === undefined) {
    throw new Error(`booking ${bookingId} has no entitlement to open or close`);
  }
  return row;
}

/**
 * Mint the access code for a window that has just started.
 *
 * The order is checked, then minted, then written, and it cannot be improved: the code
 * does not exist until Discord returns it, so the row cannot be written first. A crash
 * between the call and the commit therefore leaks a working code with no row pointing
 * at it. That orphan is bounded, and bounding it is the entire reason max_age is
 * computed from the window's own end: an orphan dies when the session it was for would
 * have ended, with no cleanup pass required. The retry then mints a second code, which
 * is why `max_uses: 1` is not the only thing keeping strangers out.
 */
export async function openWindow(
  db: Queryable,
  invites: InviteProvider,
  bookingId: string,
  now: Date,
): Promise<WindowOpenResult> {
  const row = await loadUnderLock(db, bookingId);

  // Anything other than paid/pending means something already acted: the student
  // cancelled, or a duplicate row survived. Never reopen a resolved session.
  if (row.state !== 'paid') {
    return { result: 'superseded', note: `booking is ${row.state}` };
  }
  if (row.entitlement_state !== 'pending') {
    return { result: 'superseded', note: `entitlement is ${row.entitlement_state}` };
  }

  const endsAt = asDate(row.ends_at);
  const decision = decideInviteMaxAge(endsAt, now);
  if (!decision.create) {
    // The pass is running after the session ended. Deliberately leaves the booking in
    // `paid` and the entitlement in `pending`: that is the exact state resolveWindowEnd
    // reads as "the poller missed window start entirely", and the window_close row due
    // at the same instant will resolve it to completed_unfulfilled and flag the refund.
    // Minting here instead would hand out a credential for a session already over.
    return { result: 'window_over' };
  }

  const invite = await invites.createInvite({
    maxAgeSeconds: decision.maxAgeSeconds,
    reason: `coaching booking ${bookingId}, window ends ${endsAt.toISOString()}`,
  });

  // Discord's reported expiry, not ours. If their clock runs ahead of ours this value
  // can land after ends_at; it is recorded as it is rather than clamped, because the
  // row must say when the code really dies. The delete at window_close is what enforces
  // the boundary in that case.
  await db.query(
    `INSERT INTO access_invites (entitlement_id, code, max_age_seconds, expires_at)
          VALUES ($1, $2, $3, $4)`,
    [row.entitlement_id, invite.code, decision.maxAgeSeconds, invite.expiresAt.toISOString()],
  );

  const bookingNext = bookingTransition(row.state, 'active', 'poller_window_open');
  const entitlementNext = entitlementTransition(
    row.entitlement_state, 'open', 'poller_window_open',
  );

  await db.query('UPDATE bookings SET state = $2, updated_at = $3 WHERE id = $1', [
    bookingId, bookingNext, now.toISOString(),
  ]);
  await db.query('UPDATE entitlements SET state = $2, updated_at = $3 WHERE id = $1', [
    row.entitlement_id, entitlementNext, now.toISOString(),
  ]);

  return { result: 'opened', entitlementId: row.entitlement_id, expiresAt: invite.expiresAt };
}

/**
 * Resolve a window that has ended.
 *
 * resolveWindowEnd takes no clock, so this answers the same way whether it runs on time
 * or an hour late after a deploy. The only input is whether a code was ever issued,
 * which is the existence of the access_invites row: the state it has since reached says
 * nothing, because a used, hand-deleted and expired invite are indistinguishable.
 */
export async function closeWindow(
  db: Queryable,
  invites: InviteProvider,
  bookingId: string,
  now: Date,
): Promise<WindowCloseResult> {
  const row = await loadUnderLock(db, bookingId);
  const anyCodeIssued = row.invite_code !== null;

  const outcome = resolveWindowEnd({
    bookingState: row.state,
    entitlementState: row.entitlement_state,
    anyCodeIssued,
  });

  if (outcome.kind === 'skip') return { result: 'superseded', note: outcome.reason };

  // max_age is what actually revokes a code, not this. Asking Discord is only worth a
  // network call when our own recorded expiry says the code is somehow still live, which
  // means Discord's clock ran ahead of ours when it was minted. In the ordinary case the
  // recorded expiry has passed and there is nothing to ask: that keeps a network call
  // out of the common close path entirely, and out of this transaction.
  //
  // Ordered before the state writes so a refusal is visible first. A refusal still must
  // not block the close or the refund ledger: the exposure it leaves is the few seconds
  // of skew, and a retry on the next pass would be later still, not earlier.
  let inviteRemoval: InviteRemoval = 'none';
  if (row.invite_code !== null && row.invite_state === 'issued') {
    const expiresAt = row.invite_expires_at === null ? null : asDate(row.invite_expires_at);

    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
      // Dead by its own max_age. `gone` on the authority of our own row, which holds
      // the expiry Discord itself reported, rather than on a 404 that cannot be read.
      inviteRemoval = 'expired';
      await db.query(`UPDATE access_invites SET state = 'gone' WHERE code = $1`, [
        row.invite_code,
      ]);
    } else {
      try {
        inviteRemoval = await invites.deleteInvite(row.invite_code);
        // Only a confirmed removal changes the row. `unknown` leaves it `issued`,
        // because for all we can tell the code is still live and the honest record is
        // the one that says so.
        if (inviteRemoval === 'deleted') {
          await db.query(`UPDATE access_invites SET state = 'deleted' WHERE code = $1`, [
            row.invite_code,
          ]);
        }
      } catch (err) {
        if (!(err instanceof InviteProviderError)) throw err;
        inviteRemoval = 'failed';
      }
    }
  }

  await db.query('UPDATE bookings SET state = $2, updated_at = $3 WHERE id = $1', [
    bookingId, outcome.booking, now.toISOString(),
  ]);
  await db.query('UPDATE entitlements SET state = $2, updated_at = $3 WHERE id = $1', [
    row.entitlement_id, outcome.entitlement, now.toISOString(),
  ]);
  // holds_slot is deliberately untouched: holdsSlot() is true for both completed states,
  // so a finished session keeps occupying the hour it was sold. Releasing it would offer
  // a past hour for sale and lose the record that it was ever booked.

  if (outcome.manualRefundOwed) {
    // The ledger, not an automatic refund. NOTHING in this system calls Stripe's refund
    // API: this row is what makes /ops show a red line for Alex to act on by hand.
    await db.query(
      `INSERT INTO money_events (booking_id, kind, amount_cents, note)
            VALUES ($1, 'manual_refund_owed', $2, $3)`,
      [bookingId, row.price_cents, 'window ended with no access code ever issued'],
    );
  }

  if (anyCodeIssued) {
    // A code existed, so someone may now be in the server who has no further claim to
    // be. Queueing it records the obligation; nothing verifies the discharge, because
    // this bot cannot see who is a member and is not given the permission to.
    await db.query(
      `INSERT INTO member_cleanup (entitlement_id, discord_id) VALUES ($1, $2)
       ON CONFLICT (entitlement_id) DO NOTHING`,
      [row.entitlement_id, row.student_discord_id],
    );
  }

  return {
    result: anyCodeIssued ? 'closed' : 'unfulfilled',
    booking: outcome.booking,
    entitlement: outcome.entitlement,
    manualRefundOwed: outcome.manualRefundOwed,
    inviteRemoval,
  };
}
