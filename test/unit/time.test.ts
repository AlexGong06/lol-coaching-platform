import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTimeZone, localDateKey, localWeekday, merge, overlaps, zonedToUtc,
} from '../../src/time.ts';

const iso = (s: string) => new Date(s);
const span = (a: string, b: string) => ({ start: iso(a), end: iso(b) });
const show = (i: { start: Date; end: Date }) =>
  `${i.start.toISOString()}/${i.end.toISOString()}`;

describe('timezone conversion', () => {
  test('a wall-clock time converts to the right instant in winter and summer', () => {
    // 18:00 CST is 00:00Z the next day; 18:00 CDT is 23:00Z the same day.
    assert.equal(
      zonedToUtc(2026, 11, 20, 18, 0, 'America/Chicago').date.toISOString(),
      '2026-11-21T00:00:00.000Z',
    );
    assert.equal(
      zonedToUtc(2026, 7, 10, 18, 0, 'America/Chicago').date.toISOString(),
      '2026-07-10T23:00:00.000Z',
    );
  });

  test('a time skipped by spring forward is reported as not existing', () => {
    // 2026-03-08, clocks jump 02:00 -> 03:00 in Chicago. 02:30 never happens.
    const gap = zonedToUtc(2026, 3, 8, 2, 30, 'America/Chicago');
    assert.equal(gap.exists, false, '02:30 must be reported as nonexistent');

    const before = zonedToUtc(2026, 3, 8, 1, 30, 'America/Chicago');
    const after = zonedToUtc(2026, 3, 8, 3, 30, 'America/Chicago');
    assert.equal(before.exists, true);
    assert.equal(after.exists, true);
  });

  test('a time repeated by fall back resolves to the first occurrence', () => {
    // 2026-11-01, clocks fall 02:00 -> 01:00. 01:30 happens twice: 06:30Z (CDT)
    // then 07:30Z (CST). The earlier instant is the one we offer.
    const ambiguous = zonedToUtc(2026, 11, 1, 1, 30, 'America/Chicago');
    assert.equal(ambiguous.exists, true);
    assert.equal(ambiguous.date.toISOString(), '2026-11-01T06:30:00.000Z');
  });

  test('round trip holds for a zone east of UTC', () => {
    const seoul = zonedToUtc(2026, 11, 20, 9, 0, 'Asia/Seoul');
    assert.equal(seoul.date.toISOString(), '2026-11-20T00:00:00.000Z');
    assert.equal(localDateKey(seoul.date, 'Asia/Seoul'), '2026-11-20');
  });

  test('civil date and weekday are read in the given zone, not the host zone', () => {
    // 2026-11-21T04:30Z is still Friday evening in Chicago, already Saturday in UTC.
    const instant = iso('2026-11-21T04:30:00Z');
    assert.equal(localDateKey(instant, 'America/Chicago'), '2026-11-20');
    assert.equal(localWeekday(instant, 'America/Chicago'), 5, 'Friday');
    assert.equal(localDateKey(instant, 'UTC'), '2026-11-21');
    assert.equal(localWeekday(instant, 'UTC'), 6, 'Saturday');
  });

  test('an unknown zone is rejected rather than silently treated as UTC', () => {
    assert.equal(isValidTimeZone('America/Chicago'), true);
    assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false);
  });
});

describe('interval algebra', () => {
  test('half-open intervals that merely touch do not overlap', () => {
    // This is the rule that lets a booking start at exactly 3:15 after one reserved
    // until 3:15. If it were inclusive, the gap would cost an extra slot everywhere.
    assert.equal(overlaps(span('2026-11-20T14:00Z', '2026-11-20T15:15Z'),
                          span('2026-11-20T15:15Z', '2026-11-20T16:15Z')), false);
    assert.equal(overlaps(span('2026-11-20T14:00Z', '2026-11-20T15:16Z'),
                          span('2026-11-20T15:15Z', '2026-11-20T16:15Z')), true);
  });

  test('merge unions overlapping and exactly abutting ranges', () => {
    const merged = merge([
      span('2026-11-20T12:00Z', '2026-11-20T13:00Z'),
      span('2026-11-20T13:00Z', '2026-11-20T14:00Z'),
      span('2026-11-20T13:30Z', '2026-11-20T15:00Z'),
      span('2026-11-20T18:00Z', '2026-11-20T19:00Z'),
    ]);
    assert.deepEqual(merged.map(show), [
      '2026-11-20T12:00:00.000Z/2026-11-20T15:00:00.000Z',
      '2026-11-20T18:00:00.000Z/2026-11-20T19:00:00.000Z',
    ]);
  });

});
