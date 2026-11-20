import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AvailabilityRule, candidateStarts, expandRules, summarizeDays,
} from '../../src/availability.ts';

const iso = (s: string) => new Date(s);
const span = (a: string, b: string) => ({ start: iso(a), end: iso(b) });
const show = (i: { start: Date; end: Date }) =>
  `${i.start.toISOString()}/${i.end.toISOString()}`;
const starts = (slots: { start: Date }[]) => slots.map((s) => s.start.toISOString());

// Friday evenings, Alex's own zone.
const fridayEvening: AvailabilityRule = {
  weekday: 5, startLocal: '18:00', endLocal: '22:00', tz: 'America/Chicago',
};

describe('expandRules', () => {
  test('a weekly rule becomes concrete instants in the rule own zone', () => {
    const open = expandRules([fridayEvening], span('2026-11-16T00:00Z', '2026-11-23T00:00Z'));
    // Friday 2026-11-20, 18:00 CST (-6) is 00:00Z on the 21st.
    assert.deepEqual(open.map(show), [
      '2026-11-21T00:00:00.000Z/2026-11-21T04:00:00.000Z',
    ]);
  });

  test('18:00 local stays 18:00 local on both sides of a DST change', () => {
    // The bug this guards against is stepping the cursor by 24 hours of milliseconds,
    // which drifts an hour past every transition and silently moves Alex's evening.
    const summer = expandRules([fridayEvening], span('2026-07-06T00:00Z', '2026-07-13T00:00Z'));
    const winter = expandRules([fridayEvening], span('2026-11-16T00:00Z', '2026-11-23T00:00Z'));

    // CDT (-5) in July: 18:00 local is 23:00Z the same day.
    assert.deepEqual(summer.map(show), ['2026-07-10T23:00:00.000Z/2026-07-11T03:00:00.000Z']);
    // CST (-6) in November: 18:00 local is 00:00Z the next day. Different UTC instant,
    // same wall clock for Alex and for the student.
    assert.deepEqual(winter.map(show), ['2026-11-21T00:00:00.000Z/2026-11-21T04:00:00.000Z']);
  });

  test('consecutive weeks land on the right Fridays, not a drifting cursor', () => {
    const open = expandRules([fridayEvening], span('2026-11-01T00:00Z', '2026-11-30T00:00Z'));
    assert.deepEqual(open.map((i) => i.start.toISOString()), [
      '2026-11-07T00:00:00.000Z',
      '2026-11-14T00:00:00.000Z',
      '2026-11-21T00:00:00.000Z',
      '2026-11-28T00:00:00.000Z',
    ]);
  });

  test('an occurrence whose start time does not exist is dropped, not shifted', () => {
    // Clocks jump 02:00 -> 03:00 in Chicago on 2026-03-08, so an 02:30 start has no
    // instant that day. Shifting it would open an hour Alex never agreed to.
    const earlySunday: AvailabilityRule = {
      weekday: 0, startLocal: '02:30', endLocal: '05:00', tz: 'America/Chicago',
    };
    const open = expandRules([earlySunday], span('2026-03-07T00:00Z', '2026-03-16T12:00Z'));
    assert.deepEqual(open.map(show), [
      // 2026-03-08 is absent. 2026-03-15 at 02:30 CDT (-5) is 07:30Z.
      '2026-03-15T07:30:00.000Z/2026-03-15T10:00:00.000Z',
    ]);
  });

  test('a rule is clipped to the search window rather than overflowing it', () => {
    const open = expandRules([fridayEvening], span('2026-11-21T02:00Z', '2026-11-21T03:00Z'));
    assert.deepEqual(open.map(show), ['2026-11-21T02:00:00.000Z/2026-11-21T03:00:00.000Z']);
  });

  test('a rule that does not end after it starts is a programming error', () => {
    assert.throws(
      () => expandRules([{ ...fridayEvening, startLocal: '22:00', endLocal: '18:00' }],
                        span('2026-11-16T00:00Z', '2026-11-23T00:00Z')),
      /does not end after it starts/,
    );
  });
});

describe('candidateStarts', () => {
  const open = [span('2026-11-20T18:00Z', '2026-11-20T22:00Z')];
  // Well before the window, so the lead-time floor is never the thing under test.
  const now = iso('2026-11-19T00:00Z');

  test('offers starts on the granularity grid from the start of the open range', () => {
    const slots = candidateStarts(open, [], 'live_coaching', now);
    assert.equal(starts(slots)[0], '2026-11-20T18:00:00.000Z');
    assert.equal(starts(slots)[1], '2026-11-20T18:15:00.000Z');
  });

  test('the last hour of the day is sellable even though its gap runs past closing', () => {
    // The gap separates sessions; it is not part of the working day. The database would
    // accept 21:00-22:00, so refusing to offer it would forfeit an hour every day.
    const slots = candidateStarts(open, [], 'live_coaching', now);
    assert.equal(starts(slots).at(-1), '2026-11-20T21:00:00.000Z');
  });

  test('a session that would run past closing is not offered', () => {
    const slots = candidateStarts(open, [], 'live_coaching', now);
    assert.equal(starts(slots).includes('2026-11-20T21:15:00.000Z'), false);
  });

  test('the first offer after a booking is the instant the database would accept', () => {
    // A 2:00-3:00 booking comes back from the database already padded to 3:15.
    const reserved = [span('2026-11-20T18:00Z', '2026-11-20T19:15Z')];
    const slots = candidateStarts(open, reserved, 'live_coaching', now);
    assert.equal(starts(slots)[0], '2026-11-20T19:15:00.000Z',
      'offering 19:05 would be refused by the exclusion constraint');
  });

  test("a candidate's own trailing gap must clear the next booking", () => {
    const wide = [span('2026-11-20T18:00Z', '2026-11-20T23:00Z')];
    const reserved = [span('2026-11-20T22:00Z', '2026-11-20T23:15Z')];
    const slots = candidateStarts(wide, reserved, 'live_coaching', now);
    // 21:00-22:00 would end exactly when the next booking starts, but its gap runs to
    // 22:15 and collides. 20:45 is the last start whose gap clears.
    assert.equal(starts(slots).at(-1), '2026-11-20T20:45:00.000Z');
  });

  test('the lead-time floor is measured from now, not from the window', () => {
    const late = iso('2026-11-20T17:40Z');   // floor is 18:25
    const slots = candidateStarts(open, [], 'live_coaching', late);
    assert.equal(starts(slots)[0], '2026-11-20T18:30:00.000Z',
      '18:15 is inside the 45-minute floor; 18:30 is the first grid point past it');
  });

  test('nothing is offered once the whole range is inside the floor', () => {
    assert.deepEqual(candidateStarts(open, [], 'live_coaching', iso('2026-11-20T21:00Z')), []);
  });

  describe('the Both SKU needs a contiguous two hours plus its gap', () => {
    test('refused when a booking sits in the middle of the day', () => {
      const reserved = [span('2026-11-20T19:00Z', '2026-11-20T20:15Z')];
      const slots = candidateStarts(open, reserved, 'both', now);
      // 18:00-20:00 collides, and 20:15-22:15 runs past closing. Nothing fits.
      assert.deepEqual(starts(slots), []);
    });

    test('accepted into a clear opening after that booking', () => {
      const wide = [span('2026-11-20T18:00Z', '2026-11-20T23:00Z')];
      const reserved = [span('2026-11-20T19:00Z', '2026-11-20T20:15Z')];
      const slots = candidateStarts(wide, reserved, 'both', now);
      assert.equal(starts(slots)[0], '2026-11-20T20:15:00.000Z');
    });

    test('a one-hour SKU still fits where a two-hour one does not', () => {
      const reserved = [span('2026-11-20T19:00Z', '2026-11-20T20:15Z')];
      assert.deepEqual(starts(candidateStarts(open, reserved, 'both', now)), []);
      assert.ok(candidateStarts(open, reserved, 'vod_review', now).length > 0);
    });
  });

  test('a blackout is indistinguishable from a booking', () => {
    // Both arrive as reserved ranges, which is the whole point of one table.
    const blackout = [span('2026-11-20T18:00Z', '2026-11-20T22:15Z')];
    assert.deepEqual(candidateStarts(open, blackout, 'live_coaching', now), []);
  });
});

describe('summarizeDays', () => {
  const window = span('2026-11-20T00:00Z', '2026-11-22T00:00Z');

  test('slots are grouped by the civil date in the viewer own zone', () => {
    const open = [span('2026-11-21T00:00Z', '2026-11-21T04:00Z')];
    const slots = candidateStarts(open, [], 'live_coaching', iso('2026-11-19T00:00Z'));

    // The same instants are Friday evening in Chicago and Saturday morning in UTC.
    const chicago = summarizeDays(open, slots, 'live_coaching', 'America/Chicago', window);
    assert.deepEqual(chicago.map((d) => d.date), ['2026-11-20']);

    const utc = summarizeDays(open, slots, 'live_coaching', 'UTC', window);
    assert.deepEqual(utc.map((d) => d.date), ['2026-11-21']);
  });

  test('a day with open time but no room carries the per-day note', () => {
    const open = [span('2026-11-20T18:00Z', '2026-11-20T22:00Z')];
    const reserved = [span('2026-11-20T19:00Z', '2026-11-20T20:15Z')];
    const slots = candidateStarts(open, reserved, 'both', iso('2026-11-19T00:00Z'));
    const days = summarizeDays(open, slots, 'both', 'UTC', window);

    const day = days.find((d) => d.date === '2026-11-20');
    assert.ok(day, 'the day must still appear');
    assert.deepEqual(day.slots, []);
    assert.equal(day.note, 'No continuous 2-hour blocks on this day.');
  });

  test('a day Alex does not work is omitted entirely', () => {
    const open = [span('2026-11-20T18:00Z', '2026-11-20T22:00Z')];
    const slots = candidateStarts(open, [], 'live_coaching', iso('2026-11-19T00:00Z'));
    const days = summarizeDays(open, slots, 'live_coaching', 'UTC', window);
    assert.equal(days.some((d) => d.date === '2026-11-21'), false);
  });
});
