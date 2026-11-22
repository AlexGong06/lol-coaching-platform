// GET /api/availability
//
// Framework-free on purpose. The design doc commits to Next.js App Router, and this is
// what its route handler will call:
//
//   export async function GET(request: Request) {
//     const url = new URL(request.url);
//     const result = await handleAvailability(db, Object.fromEntries(url.searchParams), new Date());
//     return Response.json(result.body, { status: result.status });
//   }
//
// Keeping the logic out of the framework means it is testable with a plain object and
// survives a decision to move off Next.js later.

import {
  GAP_MINUTES, LEAD_MINUTES, candidateStarts, expandRules, summarizeDays,
} from '../availability.ts';
import { loadAvailabilityRules, loadReservedRanges, type Queryable } from '../db/queries.ts';
import { SKUS, SKU_NAMES, isSku } from '../skus.ts';
import { type Interval, MINUTE_MS, isValidTimeZone } from '../time.ts';

/** A search may not ask for more than this, so one request cannot scan a year. */
export const MAX_WINDOW_DAYS = 60;

export type { ApiResult } from './result.ts';
import type { ApiResult } from './result.ts';

type Query = Record<string, string | undefined>;

function badRequest(code: string, message: string): ApiResult {
  return { status: 400, body: { error: { code, message } } };
}

function parseInstant(value: string): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function handleAvailability(
  db: Queryable, query: Query, now: Date,
): Promise<ApiResult> {
  const { sku, from, to, tz } = query;

  if (!isSku(sku)) {
    return badRequest('bad_sku', `sku must be one of: ${SKU_NAMES.join(', ')}`);
  }
  if (!from || !to) {
    return badRequest('missing_range', 'from and to are required ISO-8601 instants');
  }

  const start = parseInstant(from);
  const end = parseInstant(to);
  if (!start || !end) {
    return badRequest('bad_range', 'from and to must be ISO-8601 instants');
  }
  if (end.getTime() <= start.getTime()) {
    return badRequest('bad_range', 'to must be after from');
  }
  if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * 24 * 60 * MINUTE_MS) {
    return badRequest('range_too_wide', `the window may not exceed ${MAX_WINDOW_DAYS} days`);
  }

  // The zone the calendar is rendered in. Days are grouped by the student's civil date,
  // not Alex's, or a student in Seoul sees a Friday evening slot filed under Saturday.
  const viewerTz = tz ?? 'UTC';
  if (!isValidTimeZone(viewerTz)) {
    return badRequest('bad_timezone', `not an IANA time zone: ${viewerTz}`);
  }

  // Never show the past, and never inside the lead-time floor. Clamping rather than
  // rejecting means a picker left open overnight degrades to "nothing today" instead of
  // an error the student cannot act on.
  const floor = new Date(now.getTime() + LEAD_MINUTES * MINUTE_MS);
  const display: Interval = {
    start: new Date(Math.max(start.getTime(), floor.getTime())),
    end,
  };

  if (display.end.getTime() <= display.start.getTime()) {
    return {
      status: 200,
      body: {
        sku, timezone: viewerTz, leadMinutes: LEAD_MINUTES,
        durationMinutes: SKUS[sku].durationMinutes, priceCents: SKUS[sku].priceCents,
        days: [],
      },
    };
  }

  // Rules are expanded over a window reaching a full day back from the floor, so an
  // occurrence straddling the floor is expanded from its own local start time. That
  // keeps offers on the rule's grid (18:00, 18:15, ...) rather than aligning them to
  // whenever the request happened to arrive, which is what a student sees as 00:55.
  // candidateStarts is what actually enforces the floor.
  const ruleWindow: Interval = {
    start: new Date(display.start.getTime() - 24 * 60 * MINUTE_MS),
    end,
  };

  // Widened by the gap: the last offerable session ends at the window edge, and its
  // trailing gap reaches past it, so a booking just beyond the edge still rules it out.
  const reservedWindow: Interval = {
    start: display.start,
    end: new Date(display.end.getTime() + GAP_MINUTES * MINUTE_MS),
  };

  const [rules, reserved] = await Promise.all([
    loadAvailabilityRules(db),
    loadReservedRanges(db, reservedWindow),
  ]);

  const open = expandRules(rules, ruleWindow);
  const slots = candidateStarts(open, reserved, sku, now);
  const days = summarizeDays(open, slots, sku, viewerTz, display);

  return {
    status: 200,
    body: {
      sku,
      timezone: viewerTz,
      leadMinutes: LEAD_MINUTES,
      durationMinutes: SKUS[sku].durationMinutes,
      priceCents: SKUS[sku].priceCents,
      days: days.map((day) => ({
        date: day.date,
        ...(day.note ? { note: day.note } : {}),
        slots: day.slots.map((s) => ({
          start: s.start.toISOString(),
          end: s.end.toISOString(),
        })),
      })),
    },
  };
}
