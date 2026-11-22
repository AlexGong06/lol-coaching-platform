// POST /api/checkout
//
// The endpoint the booking form submits to. Same framework-free shape as
// handleAvailability, so the Next.js route handler is four lines:
//
//   export async function POST(request: Request) {
//     const result = await handleCheckout(db, provider, await request.json(), new Date());
//     return Response.json(result.body, { status: result.status });
//   }
//
// Its only real work is turning a HoldError into a status and a message a student can
// act on. Three failures look identical in a naive handler and must not be:
//
//   slot_taken   409  someone paid for this hour seconds ago. Try another slot.
//   not_offered  409  the calendar in this tab is stale. Refresh.
//   too_soon     409  this hour is still visible but no longer bookable.
//
// Telling them apart is the difference between "try again" and "something is broken".

import { createHold, HoldError, type HoldFailure, type HoldInput } from '../booking.ts';
import type { Queryable } from '../db/queries.ts';
import type { PaymentProvider } from '../payments.ts';
import { SKU_NAMES } from '../skus.ts';

export type { ApiResult } from './result.ts';
import type { ApiResult } from './result.ts';

const REQUIRED = [
  'sku',
  'start',
  'studentDiscordId',
  'studentEmail',
  'riotId',
  'studentTz',
] as const;

/** 400 is the caller's mistake; 409 is a real-world conflict the student can retry. */
const STATUS: Record<HoldFailure, number> = {
  bad_sku: 400,
  bad_start: 400,
  bad_discord_id: 400,
  bad_email: 400,
  bad_riot_id: 400,
  bad_timezone: 400,
  too_soon: 409,
  not_offered: 409,
  slot_taken: 409,
  provider_failed: 502,
};

export async function handleCheckout(
  db: Queryable,
  provider: PaymentProvider,
  body: unknown,
  now: Date,
): Promise<ApiResult> {
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { error: { code: 'bad_body', message: 'expected a JSON object' } } };
  }

  const raw = body as Record<string, unknown>;
  const missing = REQUIRED.filter((key) => typeof raw[key] !== 'string' || raw[key] === '');
  if (missing.length > 0) {
    return {
      status: 400,
      body: {
        error: {
          code: 'missing_fields',
          message: `missing or empty: ${missing.join(', ')}`,
          fields: missing,
          skus: SKU_NAMES,
        },
      },
    };
  }

  const input = Object.fromEntries(REQUIRED.map((k) => [k, raw[k]])) as unknown as HoldInput;

  try {
    const hold = await createHold(db, provider, input, now);
    // 201: a hold now exists. The student is sent to `checkoutUrl`; `holdExpiresAt` is
    // what the page counts down, so it must be the same instant the sweeper will act on.
    return {
      status: 201,
      body: {
        bookingId: hold.bookingId,
        checkoutUrl: hold.checkoutUrl,
        holdExpiresAt: hold.holdExpiresAt.toISOString(),
        startsAt: hold.startsAt.toISOString(),
        endsAt: hold.endsAt.toISOString(),
        priceCents: hold.priceCents,
      },
    };
  } catch (err) {
    if (err instanceof HoldError) {
      return { status: STATUS[err.code], body: { error: { code: err.code, message: err.message } } };
    }
    throw err;
  }
}
