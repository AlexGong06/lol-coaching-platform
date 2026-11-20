// The due-work poller.
//
// Everything in this system that happens because time passed happens here: a hold
// lapses, a session window opens, a window closes. One row of `due_work` is one such
// obligation, and this runs the ones that have come due.
//
// One row, one transaction, and the row stays locked for the whole of it:
//
//   BEGIN; SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1; handle it; mark done; COMMIT
//
// Two pollers running at once is the normal case, not an error case (a cron firing
// while the last run is still going, a deploy overlapping the one it replaces). Holding
// the lock across the handler is what makes that safe: the second poller's SKIP LOCKED
// steps over the row instead of queueing behind it, and never runs a handler the first
// poller is already running. Claiming in one transaction and handling in another would
// give the row back the instant the claim committed, which is the bug this shape avoids.
//
// Failure is per row. A handler that throws rolls back only its own row, records the
// error, and leaves `done_at` NULL so the next pass retries it.

import type { Queryable } from '../db/queries.ts';
import { bookingTransition, holdsSlot, type BookingState } from '../states.ts';

/**
 * Kinds this poller knows how to run. Rows of any other kind are left unclaimed rather
 * than claimed and marked done, so wiring up `window_open` later finds its backlog
 * waiting instead of silently discharged.
 */
export const HANDLED_KINDS = ['hold_expiry'] as const;
export type HandledKind = (typeof HANDLED_KINDS)[number];

/** Rows per pass. Bounded so one pass cannot run forever on a growing queue. */
export const DEFAULT_BATCH = 20;

export interface SweepOutcome {
  workId: string;
  kind: HandledKind;
  bookingId: string | null;
  /**
   * `released` the slot went back on sale, `superseded` the booking had already moved
   * on (the webhook won the race), `failed` the handler threw and the row stays queued.
   */
  result: 'released' | 'superseded' | 'failed';
  error?: string;
}

interface WorkRow {
  id: string;
  kind: HandledKind;
  booking_id: string | null;
}

interface BookingRow {
  id: string;
  state: BookingState;
  reservation_id: string;
}

function firstRow<T>(rows: unknown[]): T | undefined {
  return rows[0] as T | undefined;
}

async function rollback(db: Queryable): Promise<void> {
  try {
    await db.query('ROLLBACK');
  } catch {
    /* ignore: never mask the error that explains what went wrong */
  }
}

/**
 * Run one pass, returning what it did. The outcomes are the point: a caller logs them
 * and a test asserts them, rather than inferring the work from its side effects.
 *
 * `db` must be a dedicated connection, not a pool. BEGIN and COMMIT are plain
 * statements and a pool may route them to different backends.
 */
export async function sweepDueWork(
  db: Queryable,
  now: Date,
  batch = DEFAULT_BATCH,
): Promise<SweepOutcome[]> {
  const outcomes: SweepOutcome[] = [];
  // Rows this pass has already handled or failed. Without it a row whose handler throws
  // is immediately re-selected (its `done_at` is still NULL) and the pass spins on it.
  const seen: string[] = [];

  for (let i = 0; i < batch; i += 1) {
    const outcome = await runNext(db, now, seen);
    if (outcome === null) break;
    seen.push(outcome.workId);
    outcomes.push(outcome);
  }

  return outcomes;
}

async function runNext(db: Queryable, now: Date, seen: string[]): Promise<SweepOutcome | null> {
  await db.query('BEGIN');
  let work: WorkRow | undefined;

  try {
    const { rows } = await db.query(
      `SELECT id, kind, booking_id
         FROM due_work
        WHERE done_at IS NULL
          AND due_at <= $1
          AND kind = ANY($2::due_work_kind[])
          AND id <> ALL($3::bigint[])
        ORDER BY due_at
        LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), HANDLED_KINDS as readonly string[], seen],
    );

    work = firstRow<WorkRow>(rows);
    if (work === undefined) {
      await db.query('COMMIT');
      return null;
    }

    // Only one handled kind so far; `work.kind` is typed to it, so adding `window_open`
    // to HANDLED_KINDS turns this into a type error until it is dispatched.
    const result = await expireHold(db, work, now);

    await db.query(
      `UPDATE due_work
          SET done_at = $2, attempts = attempts + 1, last_error = NULL
        WHERE id = $1`,
      [work.id, now.toISOString()],
    );
    await db.query('COMMIT');

    return { workId: work.id, kind: work.kind, bookingId: work.booking_id, result };
  } catch (err) {
    await rollback(db);
    // The SELECT itself failed, so there is no row to blame or record against.
    if (work === undefined) throw err;

    const message = err instanceof Error ? err.message : String(err);
    try {
      await db.query(
        'UPDATE due_work SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
        [work.id, message],
      );
    } catch {
      /* the connection is in worse shape than this one row */
    }
    return {
      workId: work.id,
      kind: work.kind,
      bookingId: work.booking_id,
      result: 'failed',
      error: message,
    };
  }
}

/**
 * Release an unpaid hold.
 *
 * The lock on the booking is what makes this safe. Between this poller claiming the
 * work and updating the booking, Stripe's webhook can land and move the same booking to
 * `paid`. `FOR UPDATE` serializes the two, and the state check decides the winner: if
 * the booking is no longer `pending_payment`, the student paid in time and the slot must
 * stay held. That is the whole reason `expired_hold` is not a terminal state.
 */
async function expireHold(
  db: Queryable,
  work: WorkRow,
  now: Date,
): Promise<'released' | 'superseded'> {
  if (work.booking_id === null) throw new Error('hold_expiry work row has no booking');

  const { rows } = await db.query(
    'SELECT id, state, reservation_id FROM bookings WHERE id = $1 FOR UPDATE',
    [work.booking_id],
  );
  const booking = firstRow<BookingRow>(rows);
  if (booking === undefined) throw new Error(`booking ${work.booking_id} is gone`);

  if (booking.state !== 'pending_payment') return 'superseded';

  const next = bookingTransition(booking.state, 'expired_hold', 'poller_hold_expiry');
  await db.query('UPDATE bookings SET state = $2, updated_at = $3 WHERE id = $1', [
    booking.id,
    next,
    now.toISOString(),
  ]);
  // Derived from the state, not written as a literal `false`, so occupancy and the
  // state machine cannot drift apart.
  await db.query('UPDATE reservations SET holds_slot = $2 WHERE id = $1', [
    booking.reservation_id,
    holdsSlot(next),
  ]);
  return 'released';
}
