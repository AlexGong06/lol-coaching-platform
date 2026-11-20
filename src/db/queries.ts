// Database reads for availability search.
//
// Typed against a structural `Queryable` rather than pg.Client, so a test can pass a
// fake and the pure search logic stays reachable without a server. The real pg.Client
// satisfies this shape as-is.

import type { AvailabilityRule } from '../availability.ts';
import type { Interval } from '../time.ts';

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface RuleRow {
  weekday: number;
  start_local: string;
  end_local: string;
  tz: string;
}

interface RangeRow {
  starts: Date | string;
  ends: Date | string;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function loadAvailabilityRules(db: Queryable): Promise<AvailabilityRule[]> {
  const { rows } = await db.query(
    `SELECT weekday, start_local::text AS start_local, end_local::text AS end_local, tz
       FROM availability_rules
      ORDER BY weekday, start_local`,
  );
  return (rows as RuleRow[]).map((r) => ({
    weekday: r.weekday,
    startLocal: r.start_local,
    endLocal: r.end_local,
    tz: r.tz,
  }));
}

/**
 * Every range that currently occupies time and touches `window`.
 *
 * Reads `reserved` rather than starts_at/ends_at, so the 15-minute gap the trigger
 * folded in comes back with the row and search pads exactly the way the exclusion
 * constraint does. `holds_slot` is the same predicate the constraint uses, so a lapsed
 * hold or a cancellation stops occupying time here the instant it does there.
 *
 * Both kinds come back together on purpose: a blackout and a booking are
 * indistinguishable to search, because to a student they are.
 */
export async function loadReservedRanges(db: Queryable, window: Interval): Promise<Interval[]> {
  const { rows } = await db.query(
    `SELECT lower(reserved) AS starts, upper(reserved) AS ends
       FROM reservations
      WHERE holds_slot
        AND reserved && tstzrange($1, $2)
      ORDER BY starts`,
    [window.start.toISOString(), window.end.toISOString()],
  );
  return (rows as RangeRow[]).map((r) => ({ start: asDate(r.starts), end: asDate(r.ends) }));
}
