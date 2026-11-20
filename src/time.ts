// Interval algebra and IANA timezone conversion, with no dependencies.
//
// Node 26 ships no Temporal, so the zone math is done against Intl. That is not a
// hardship: the conversion we need is narrow, and writing it out means the two cases
// that actually bite are visible and tested rather than hidden in a library.
//
// Every interval in this system is half-open, [start, end). The database agrees:
// tstzrange(a, b) defaults to '[)', which is why a booking reserved until 3:15 does
// not collide with one starting at exactly 3:15.

export interface Interval {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

export const MINUTE_MS = 60_000;

// ------------------------------------------------------------------ timezones

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    // Throws RangeError on an unknown zone, which is the validation we want.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall-clock reading in `tz` at instant `ms`, re-encoded as though that reading
 * were itself UTC. Comparing this to a target wall-clock value is what lets us invert
 * the conversion without a zone database of our own.
 */
function wallClockAsUtc(ms: number, tz: string): number {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl gave no ${type} for ${tz}`);
    return Number(part.value);
  };
  // Some ICU builds render midnight as hour 24 rather than 0.
  const hour = get('hour') % 24;
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds. East of UTC is positive. */
function tzOffsetMs(ms: number, tz: string): number {
  return wallClockAsUtc(ms, tz) - ms;
}

export interface ZonedInstant {
  date: Date;
  /**
   * False when the requested wall-clock time does not exist in that zone, which
   * happens in the hour skipped by a spring-forward transition. Callers must decide
   * what to do; availability search drops the occurrence rather than silently
   * shifting a session an hour.
   */
  exists: boolean;
}

/**
 * Convert a wall-clock time in `tz` to an instant.
 *
 * Two passes, because the offset we need depends on the instant we are trying to find.
 * The first guess uses the offset at the same wall-clock reading interpreted as UTC;
 * if applying it lands in a different offset (a DST boundary sits between), the second
 * pass corrects it.
 *
 * Ambiguous times, the hour repeated by a fall-back transition, resolve to the FIRST
 * occurrence (still in daylight time). Picked deliberately: it is the earlier instant,
 * so a session offered at an ambiguous local time cannot drift later than advertised.
 */
export function zonedToUtc(
  year: number, month: number, day: number, hour: number, minute: number, tz: string,
): ZonedInstant {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = tzOffsetMs(target, tz);
  let ms = target - firstOffset;
  const secondOffset = tzOffsetMs(ms, tz);
  if (secondOffset !== firstOffset) ms = target - secondOffset;
  return { date: new Date(ms), exists: wallClockAsUtc(ms, tz) === target };
}

/** The civil date in `tz` at instant `d`, as 'YYYY-MM-DD'. */
export function localDateKey(d: Date, tz: string): string {
  const ms = wallClockAsUtc(d.getTime(), tz);
  return new Date(ms).toISOString().slice(0, 10);
}

/** Day of week in `tz` at instant `d`, 0 = Sunday, matching availability_rules.weekday. */
export function localWeekday(d: Date, tz: string): number {
  return new Date(wallClockAsUtc(d.getTime(), tz)).getUTCDay();
}

// ------------------------------------------------------------------ intervals

function isEmpty(i: Interval): boolean {
  return i.end.getTime() <= i.start.getTime();
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start.getTime() <= inner.start.getTime()
    && inner.end.getTime() <= outer.end.getTime();
}

/** Ascending by start, then by end. Does not mutate the input. */
function sortIntervals(intervals: Interval[]): Interval[] {
  return [...intervals].sort(
    (x, y) => x.start.getTime() - y.start.getTime() || x.end.getTime() - y.end.getTime(),
  );
}

/** Union of overlapping or exactly abutting intervals. */
export function merge(intervals: Interval[]): Interval[] {
  const sorted = sortIntervals(intervals.filter((i) => !isEmpty(i)));
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start.getTime() <= last.end.getTime()) {
      if (i.end.getTime() > last.end.getTime()) last.end = new Date(i.end.getTime());
    } else {
      out.push({ start: new Date(i.start.getTime()), end: new Date(i.end.getTime()) });
    }
  }
  return out;
}
