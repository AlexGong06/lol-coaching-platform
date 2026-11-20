import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WINDOW_DAYS, handleAvailability } from '../../src/api/availability.ts';
import type { Queryable } from '../../src/db/queries.ts';

const iso = (s: string) => new Date(s);

interface Body {
  sku?: string;
  timezone?: string;
  leadMinutes?: number;
  durationMinutes?: number;
  priceCents?: number;
  days?: { date: string; note?: string; slots: { start: string; end: string }[] }[];
  error?: { code: string; message: string };
}

/** A database that answers the two availability queries and records what it was asked. */
function fakeDb(
  rules: { weekday: number; start_local: string; end_local: string; tz: string }[],
  reserved: { starts: string; ends: string }[] = [],
): Queryable & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes('availability_rules')) return { rows: rules };
      if (sql.includes('reservations')) return { rows: reserved };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const fridayEvening = {
  weekday: 5, start_local: '18:00:00', end_local: '22:00:00', tz: 'America/Chicago',
};

describe('GET /api/availability validation', () => {
  const db = fakeDb([fridayEvening]);
  const now = iso('2026-11-19T00:00Z');
  const range = { from: '2026-11-16T00:00:00Z', to: '2026-11-23T00:00:00Z' };

  test('an unknown sku is a 400 that names the valid ones', async () => {
    const r = await handleAvailability(db, { ...range, sku: 'coaching' }, now);
    assert.equal(r.status, 400);
    assert.equal((r.body as Body).error?.code, 'bad_sku');
    assert.match((r.body as Body).error?.message ?? '', /vod_review/);
  });

  test('a missing range is a 400, not an unbounded scan', async () => {
    const r = await handleAvailability(db, { sku: 'both' }, now);
    assert.equal(r.status, 400);
    assert.equal((r.body as Body).error?.code, 'missing_range');
  });

  test('unparseable instants are rejected', async () => {
    const r = await handleAvailability(db, { sku: 'both', from: 'next friday', to: 'soon' }, now);
    assert.equal(r.status, 400);
    assert.equal((r.body as Body).error?.code, 'bad_range');
  });

  test('a backwards range is rejected', async () => {
    const r = await handleAvailability(
      db, { sku: 'both', from: range.to, to: range.from }, now);
    assert.equal(r.status, 400);
    assert.equal((r.body as Body).error?.code, 'bad_range');
  });

  test('a window wider than the cap is rejected', async () => {
    const to = new Date(iso(range.from).getTime() + (MAX_WINDOW_DAYS + 1) * 86_400_000);
    const r = await handleAvailability(
      db, { sku: 'both', from: range.from, to: to.toISOString() }, now);
    assert.equal(r.status, 400);
    assert.equal((r.body as Body).error?.code, 'range_too_wide');
  });

  test('an invalid timezone is rejected rather than silently treated as UTC', async () => {
    const r = await handleAvailability(
      db, { ...range, sku: 'both', tz: 'Mars/Olympus_Mons' }, now);
    assert.equal(r.status, 400);
    assert.equal((r.body as Body).error?.code, 'bad_timezone');
  });
});

describe('GET /api/availability results', () => {
  const now = iso('2026-11-19T00:00Z');
  const range = { from: '2026-11-16T00:00:00Z', to: '2026-11-23T00:00:00Z' };

  test('returns the SKU terms alongside the slots, so the UI needs one call', async () => {
    const r = await handleAvailability(
      fakeDb([fridayEvening]), { ...range, sku: 'both', tz: 'America/Chicago' }, now);
    const body = r.body as Body;
    assert.equal(r.status, 200);
    assert.equal(body.sku, 'both');
    assert.equal(body.durationMinutes, 120);
    assert.equal(body.priceCents, 6000);
    assert.equal(body.leadMinutes, 45);
    assert.equal(body.timezone, 'America/Chicago');
  });

  test('slots are grouped under the student civil date, not Alex', async () => {
    const r = await handleAvailability(
      fakeDb([fridayEvening]), { ...range, sku: 'live_coaching', tz: 'Asia/Seoul' }, now);
    const body = r.body as Body;
    // Friday 18:00 Chicago is Saturday 09:00 in Seoul.
    assert.deepEqual(body.days?.map((d) => d.date), ['2026-11-21']);
    assert.equal(body.days?.[0]?.slots[0]?.start, '2026-11-21T00:00:00.000Z');
  });

  test('a reserved range removes the slots it covers', async () => {
    const db = fakeDb([fridayEvening], [
      { starts: '2026-11-21T00:00:00Z', ends: '2026-11-21T01:15:00Z' },
    ]);
    const r = await handleAvailability(db, { ...range, sku: 'live_coaching', tz: 'UTC' }, now);
    const slots = (r.body as Body).days?.[0]?.slots ?? [];
    assert.equal(slots[0]?.start, '2026-11-21T01:15:00.000Z');
  });

  test('a fragmented day carries the note instead of an empty list with no reason', async () => {
    const db = fakeDb([fridayEvening], [
      { starts: '2026-11-21T01:00:00Z', ends: '2026-11-21T02:15:00Z' },
    ]);
    const r = await handleAvailability(db, { ...range, sku: 'both', tz: 'UTC' }, now);
    const day = (r.body as Body).days?.[0];
    assert.deepEqual(day?.slots, []);
    assert.equal(day?.note, 'No continuous 2-hour blocks on this day.');
  });

  test('a window entirely in the past returns no days and queries nothing', async () => {
    const db = fakeDb([fridayEvening]);
    const r = await handleAvailability(
      db, { sku: 'both', from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' },
      iso('2026-11-19T00:00Z'));
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as Body).days, []);
    assert.deepEqual(db.calls, [], 'a past window must not reach the database');
  });

  test('the lead-time floor clamps the window rather than erroring', async () => {
    // Asking from "now" during Alex Friday evening still works; it just starts later.
    const db = fakeDb([fridayEvening]);
    const r = await handleAvailability(
      db, { sku: 'live_coaching', from: '2026-11-21T00:00:00Z', to: '2026-11-22T00:00:00Z',
            tz: 'UTC' },
      iso('2026-11-21T00:10:00Z'));
    const slots = (r.body as Body).days?.[0]?.slots ?? [];
    assert.equal(r.status, 200);
    assert.equal(slots[0]?.start, '2026-11-21T01:00:00.000Z',
      'floor is 00:55, so the first grid point offered is 01:00');
  });

  test('tz defaults to UTC when the caller does not say', async () => {
    const r = await handleAvailability(
      fakeDb([fridayEvening]), { ...range, sku: 'both' }, now);
    assert.equal((r.body as Body).timezone, 'UTC');
  });
});
