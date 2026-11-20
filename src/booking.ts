// The write path: turning an offered start time into a held slot and a Checkout session.
//
// Everything here happens in ONE transaction, because a hold without a payment session
// is an hour taken off sale for nothing, and a payment session without a hold is a
// student paying for a slot anyone else can still buy. Rolling both back together is
// the only state the system can recover from without a human.
//
// That means a network call to the payment provider runs with a database transaction
// open, holding a lock on the reservation row for as long as the provider takes. This
// is a known antipattern and it is deliberate here: at one coach the connection pool
// will never feel it, and the alternative (insert pending, call out, commit the session
// id separately, reap sessionless rows) is real complexity for a load this project does
// not have. If concurrent checkouts ever exhaust the pool, that split is the fix.
//
// `db` must be a dedicated connection, not a pool: BEGIN and COMMIT are sent as plain
// statements, and a pool is free to route them to different backends.

import { GAP_MINUTES, LEAD_MINUTES, candidateStarts, expandRules } from './availability.ts';
import { loadAvailabilityRules, loadReservedRanges, type Queryable } from './db/queries.ts';
import type { PaymentProvider } from './payments.ts';
import { SKUS, isSku, type Sku } from './skus.ts';
import { MINUTE_MS, isValidTimeZone, type Interval } from './time.ts';

/**
 * Added to the provider's own expiry before the sweeper is allowed to reap the hold.
 * Without it the sweeper and a student paying in the final second race, and the loser
 * is a payment for a released slot: recoverable, but it costs Alex a manual refund.
 */
export const HOLD_GRACE_SECONDS = 60;

/** A Discord snowflake. Checked for shape only; the bot discovers a bad one later. */
const DISCORD_ID = /^\d{17,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * gameName#TAG. Shape only, never against the Riot API: a development key expires
 * every 24 hours and must not be able to block a payment.
 */
const RIOT_ID = /^.{3,16}#[A-Za-z0-9]{3,5}$/u;

export type HoldFailure =
  | 'bad_sku'
  | 'bad_start'
  | 'bad_discord_id'
  | 'bad_email'
  | 'bad_riot_id'
  | 'bad_timezone'
  /** Inside the 45-minute lead time as measured now, whatever the calendar showed. */
  | 'too_soon'
  /** Not a start time search would offer: outside open hours, or off the grid. */
  | 'not_offered'
  /** Lost the race. Someone else's INSERT landed first. */
  | 'slot_taken'
  /** The provider could not be reached. Nothing was kept. */
  | 'provider_failed';

export class HoldError extends Error {
  code: HoldFailure;

  constructor(code: HoldFailure, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'HoldError';
    this.code = code;
  }
}

export interface HoldInput {
  sku: string;
  /** ISO-8601 instant. The exact start the student clicked, not a rounded one. */
  start: string;
  studentDiscordId: string;
  studentEmail: string;
  riotId: string;
  studentTz: string;
}

export interface Hold {
  bookingId: string;
  reservationId: string;
  sessionId: string;
  checkoutUrl: string;
  holdExpiresAt: Date;
  startsAt: Date;
  endsAt: Date;
  priceCents: number;
}

interface ValidInput {
  sku: Sku;
  start: Date;
  end: Date;
  studentDiscordId: string;
  studentEmail: string;
  riotId: string;
  studentTz: string;
}

/** Everything checkable without touching the database, including the lead-time floor. */
function validate(input: HoldInput, now: Date): ValidInput {
  if (!isSku(input.sku)) throw new HoldError('bad_sku', `unknown sku: ${String(input.sku)}`);

  const start = new Date(input.start);
  if (Number.isNaN(start.getTime())) {
    throw new HoldError('bad_start', 'start must be an ISO-8601 instant');
  }
  if (!DISCORD_ID.test(input.studentDiscordId)) {
    throw new HoldError('bad_discord_id', 'studentDiscordId must be a Discord snowflake');
  }
  if (!EMAIL.test(input.studentEmail)) {
    throw new HoldError('bad_email', 'studentEmail must be an email address');
  }
  if (!RIOT_ID.test(input.riotId)) {
    throw new HoldError('bad_riot_id', 'riotId must look like gameName#TAG');
  }
  if (!isValidTimeZone(input.studentTz)) {
    throw new HoldError('bad_timezone', 'studentTz must be an IANA time zone');
  }

  // Re-checked from this instant, not from when the calendar rendered. A student who
  // left the page open for an hour must not be able to buy a session starting in five
  // minutes: the lead time is what makes the pre-session prep possible at all.
  if (start.getTime() < now.getTime() + LEAD_MINUTES * MINUTE_MS) {
    throw new HoldError('too_soon', `sessions must start at least ${LEAD_MINUTES} minutes out`);
  }

  const end = new Date(start.getTime() + SKUS[input.sku].durationMinutes * MINUTE_MS);
  return {
    sku: input.sku,
    start,
    end,
    studentDiscordId: input.studentDiscordId,
    studentEmail: input.studentEmail,
    riotId: input.riotId,
    studentTz: input.studentTz,
  };
}

/**
 * Whether search would offer this exact start, re-asked inside the transaction.
 *
 * The exclusion constraint cannot do this job. It knows about collisions with other
 * reservations and nothing about Alex's working hours, so without this check a crafted
 * POST buys a 4 AM session on an empty calendar. The windows mirror the ones in
 * handleAvailability: rules expand from a day earlier so an evening straddling the
 * floor keeps its own grid anchor, and reserved ranges are read a gap past the end
 * because the row after this one blocks it through its leading edge.
 */
async function assertOffered(db: Queryable, v: ValidInput, now: Date): Promise<void> {
  const padded = new Date(v.end.getTime() + GAP_MINUTES * MINUTE_MS);
  const ruleWindow: Interval = {
    start: new Date(v.start.getTime() - 24 * 60 * MINUTE_MS),
    end: padded,
  };
  const reservedWindow: Interval = { start: v.start, end: padded };

  const [rules, reserved] = await Promise.all([
    loadAvailabilityRules(db),
    loadReservedRanges(db, reservedWindow),
  ]);

  const offered = candidateStarts(expandRules(rules, ruleWindow), reserved, v.sku, now);
  if (!offered.some((slot) => slot.start.getTime() === v.start.getTime())) {
    throw new HoldError(
      'not_offered',
      'that start time is not on the calendar; refresh and pick again',
    );
  }
}

function isOverlapViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === '23P01' && e.constraint === 'reservations_no_overlap';
}

async function rollback(db: Queryable): Promise<void> {
  // Swallowed on purpose: a ROLLBACK that fails (the connection died mid-transaction,
  // say) must not replace the error that explains what actually went wrong.
  try {
    await db.query('ROLLBACK');
  } catch {
    /* ignore */
  }
}

function firstRow<T>(rows: unknown[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a returned row');
  return row as T;
}

/**
 * Reserve the slot, record the booking, open a Checkout session, and schedule the
 * hold's own expiry. All or nothing.
 *
 * Throws HoldError for everything a caller can act on. `slot_taken` and `not_offered`
 * mean different things to a student and must stay distinguishable: the first is a race
 * worth re-trying immediately, the second means their calendar is stale.
 */
export async function createHold(
  db: Queryable,
  provider: PaymentProvider,
  input: HoldInput,
  now: Date,
): Promise<Hold> {
  const v = validate(input, now);
  const priceCents = SKUS[v.sku].priceCents;

  await db.query('BEGIN');
  try {
    await assertOffered(db, v, now);

    let reservationId: string;
    try {
      const { rows } = await db.query(
        `INSERT INTO reservations (kind, starts_at, ends_at)
              VALUES ('booking', $1, $2)
           RETURNING id`,
        [v.start.toISOString(), v.end.toISOString()],
      );
      reservationId = firstRow<{ id: string }>(rows).id;
    } catch (err) {
      if (isOverlapViolation(err)) {
        throw new HoldError('slot_taken', 'that slot was just taken', err);
      }
      throw err;
    }

    const { rows: bookingRows } = await db.query(
      `INSERT INTO bookings
              (reservation_id, sku, student_discord_id, student_email, riot_id,
               student_tz, price_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id`,
      [
        reservationId,
        v.sku,
        v.studentDiscordId,
        v.studentEmail,
        v.riotId,
        v.studentTz,
        priceCents,
      ],
    );
    const bookingId = firstRow<{ id: string }>(bookingRows).id;

    let session;
    try {
      session = await provider.createCheckoutSession({
        bookingId,
        sku: v.sku,
        priceCents,
        email: v.studentEmail,
      });
    } catch (err) {
      // The reservation and booking inserted above go with it. A provider failure that
      // left them behind would take the hour off sale until the sweeper noticed.
      throw new HoldError(
        'provider_failed',
        'could not open a payment session; nothing was reserved',
        err,
      );
    }

    const holdExpiresAt = new Date(session.expiresAt.getTime() + HOLD_GRACE_SECONDS * 1000);

    await db.query(
      `UPDATE bookings
          SET stripe_session_id = $1, hold_expires_at = $2, updated_at = now()
        WHERE id = $3`,
      [session.sessionId, holdExpiresAt.toISOString(), bookingId],
    );

    // The row that will release this slot if the student walks away. Enqueued in the
    // same transaction as the hold, so a hold can never exist without its own expiry.
    await db.query(
      `INSERT INTO due_work (kind, booking_id, due_at) VALUES ('hold_expiry', $1, $2)`,
      [bookingId, holdExpiresAt.toISOString()],
    );

    await db.query('COMMIT');

    return {
      bookingId,
      reservationId,
      sessionId: session.sessionId,
      checkoutUrl: session.url,
      holdExpiresAt,
      startsAt: v.start,
      endsAt: v.end,
      priceCents,
    };
  } catch (err) {
    await rollback(db);
    throw err;
  }
}
