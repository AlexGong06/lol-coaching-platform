// Availability search: what start times may be offered, and why.
//
// Pure. No database, no clock of its own: `now` is always an argument, so a test can
// place itself at a DST boundary and a search running late cannot quietly offer a slot
// it would have refused a minute earlier.
//
// Search is deliberately NOT the authority on double-booking. The exclusion constraint
// in migration 001 is, and it already works. That inverts the usual burden: search
// only has to be good, because INSERT is what decides, and two students who both pass
// search resolve first-click-wins with one of them getting 23P01. The cost of search
// being slightly wrong is a refreshed calendar, not a double sale.

import {
  type Interval, MINUTE_MS, contains, localDateKey, localWeekday, merge, overlaps,
  zonedToUtc,
} from './time.ts';
import { type Sku, durationMinutes } from './skus.ts';

/** Reserved after every session, and folded into `reservations.reserved` by the trigger. */
export const GAP_MINUTES = 15;

/**
 * Nothing may be offered starting sooner than this. Re-checked inside the transaction
 * that creates the hold, measured from that moment: see the design doc. It must stay
 * strictly longer than the Checkout session's own 30-minute life, or a student could
 * pay for a session whose window had already opened.
 */
export const LEAD_MINUTES = 45;

/**
 * Offered start times step by this much inside an open range, aligned to the start of
 * the range rather than to the clock. The design doc does not specify a granularity;
 * 15 minutes is chosen to match the gap, so the next offer after a 2:00-3:00 booking is
 * 3:15 — the first instant the database would actually accept. A 30-minute grid would
 * forfeit that quarter hour on every boundary.
 */
export const DEFAULT_GRANULARITY_MINUTES = 15;

/** A row of `availability_rules`: a recurring weekly open range in Alex's own zone. */
export interface AvailabilityRule {
  /** 0 = Sunday, matching the column's CHECK. */
  weekday: number;
  /** 'HH:MM' or 'HH:MM:SS' local wall-clock. */
  startLocal: string;
  endLocal: string;
  /** IANA zone name. */
  tz: string;
}

export interface Slot {
  start: Date;
  end: Date;
  sku: Sku;
}

export interface SearchOptions {
  granularityMinutes?: number;
  gapMinutes?: number;
  leadMinutes?: number;
}

/** Split a 'YYYY-MM-DD' key from localDateKey into numbers the compiler can trust. */
function parseDateKey(key: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`not a date key: ${key}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function parseLocalTime(value: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) throw new Error(`availability rule time is not HH:MM: ${value}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`availability rule time out of range: ${value}`);
  return { hour, minute };
}

/**
 * Turn recurring weekly rules into concrete UTC intervals covering `window`.
 *
 * Walks civil days in each rule's own zone rather than stepping 24 hours at a time: a
 * day is not always 24 hours long, and stepping by milliseconds drifts an hour past
 * every DST boundary, which would silently move Alex's Friday evening availability.
 *
 * A rule whose start time does not exist on a given day (the hour a spring-forward
 * transition skips) is dropped for that day. Shifting it would open hours Alex never
 * agreed to.
 */
export function expandRules(rules: AvailabilityRule[], window: Interval): Interval[] {
  const out: Interval[] = [];

  for (const rule of rules) {
    const start = parseLocalTime(rule.startLocal);
    const end = parseLocalTime(rule.endLocal);
    const startMinutes = start.hour * 60 + start.minute;
    const endMinutes = end.hour * 60 + end.minute;
    if (endMinutes <= startMinutes) {
      throw new Error(`availability rule does not end after it starts: ${rule.startLocal}-${rule.endLocal}`);
    }

    // One civil day of slack each side, because a zone east or west of UTC can place a
    // local day's range partly inside a UTC window that does not contain that date.
    let cursor = new Date(window.start.getTime() - 24 * 60 * MINUTE_MS);
    const limit = window.end.getTime() + 24 * 60 * MINUTE_MS;

    while (cursor.getTime() <= limit) {
      const key = localDateKey(cursor, rule.tz);
      const civil = parseDateKey(key);
      if (localWeekday(cursor, rule.tz) === rule.weekday) {
        const { year, month, day } = civil;
        const from = zonedToUtc(year, month, day, start.hour, start.minute, rule.tz);
        const to = zonedToUtc(year, month, day, end.hour, end.minute, rule.tz);
        if (from.exists && to.date.getTime() > from.date.getTime()) {
          const clipped = {
            start: new Date(Math.max(from.date.getTime(), window.start.getTime())),
            end: new Date(Math.min(to.date.getTime(), window.end.getTime())),
          };
          if (clipped.end.getTime() > clipped.start.getTime()) out.push(clipped);
        }
      }
      // Advance to the next civil day in the rule's zone by stepping to noon local,
      // which no DST transition has ever moved across a date boundary.
      const noon = zonedToUtc(civil.year, civil.month, civil.day, 12, 0, rule.tz).date.getTime();
      cursor = new Date(noon + 24 * 60 * MINUTE_MS);
    }
  }

  return merge(out);
}

/**
 * Start times that may be offered for `sku`.
 *
 * Two separate conditions, which is the part worth being careful about:
 *
 *   1. the session body [start, start+duration) must fit inside Alex's open time, and
 *   2. the session PLUS its trailing gap must not touch anything already reserved.
 *
 * They are not the same test and collapsing them loses real money. A 1-hour session at
 * 9:00 PM when Alex is open until 10:00 PM is fine even though its gap runs to 10:15:
 * the gap exists to separate sessions, not to shorten the working day, and the database
 * would accept that booking. Requiring the gap to fit inside the open range too would
 * make the last hour of every day unsellable.
 *
 * `reserved` ranges come from the database already carrying their own trailing gap, so
 * condition 2 compares a padded candidate against padded existing rows, exactly as the
 * exclusion constraint does.
 */
export function candidateStarts(
  open: Interval[],
  reserved: Interval[],
  sku: Sku,
  now: Date,
  options: SearchOptions = {},
): Slot[] {
  const step = (options.granularityMinutes ?? DEFAULT_GRANULARITY_MINUTES) * MINUTE_MS;
  const gap = (options.gapMinutes ?? GAP_MINUTES) * MINUTE_MS;
  const lead = (options.leadMinutes ?? LEAD_MINUTES) * MINUTE_MS;
  if (step <= 0) throw new Error('granularity must be positive');

  const duration = durationMinutes(sku) * MINUTE_MS;
  const earliest = now.getTime() + lead;
  const busy = merge(reserved);
  const slots: Slot[] = [];

  for (const range of merge(open)) {
    for (let t = range.start.getTime(); t + duration <= range.end.getTime(); t += step) {
      if (t < earliest) continue;
      const body = { start: new Date(t), end: new Date(t + duration) };
      if (!contains(range, body)) continue;
      const padded = { start: body.start, end: new Date(t + duration + gap) };
      if (busy.some((b) => overlaps(padded, b))) continue;
      slots.push({ start: body.start, end: body.end, sku });
    }
  }

  return slots;
}

export interface DaySummary {
  /** Civil date in the viewer's zone, 'YYYY-MM-DD'. */
  date: string;
  slots: Slot[];
  /**
   * Set when the day holds open time but no opening long enough for this SKU. The
   * design doc commits to a per-day note rather than a global banner, so that a
   * fragmented calendar is distinguishable from a broken one.
   */
  note?: string;
}

/**
 * Group slots by civil day in `viewerTz`, and mark days that have open time but no
 * room for this SKU. Days with neither are omitted: there is nothing to say about a
 * day Alex does not work.
 */
export function summarizeDays(
  open: Interval[], slots: Slot[], sku: Sku, viewerTz: string, window: Interval,
): DaySummary[] {
  const byDate = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = localDateKey(slot.start, viewerTz);
    const bucket = byDate.get(key);
    if (bucket) bucket.push(slot); else byDate.set(key, [slot]);
  }

  const openDates = new Set<string>();
  for (const range of merge(open)) {
    const clipped = {
      start: new Date(Math.max(range.start.getTime(), window.start.getTime())),
      end: new Date(Math.min(range.end.getTime(), window.end.getTime())),
    };
    if (clipped.end.getTime() <= clipped.start.getTime()) continue;
    // Walk the range in hours so a range spanning midnight in the viewer's zone marks
    // both civil dates.
    for (let t = clipped.start.getTime(); t < clipped.end.getTime(); t += 60 * MINUTE_MS) {
      openDates.add(localDateKey(new Date(t), viewerTz));
    }
    openDates.add(localDateKey(new Date(clipped.end.getTime() - 1), viewerTz));
  }

  const hours = durationMinutes(sku) / 60;
  const dates = [...new Set([...byDate.keys(), ...openDates])].sort();

  return dates.map((date) => {
    const daySlots = byDate.get(date) ?? [];
    if (daySlots.length > 0) return { date, slots: daySlots };
    return {
      date,
      slots: [],
      note: `No continuous ${hours}-hour blocks on this day.`,
    };
  });
}
