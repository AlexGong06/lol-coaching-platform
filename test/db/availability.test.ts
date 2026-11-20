// Availability search against a real PostgreSQL.
//
// The unit tests prove the search logic in isolation. These prove the two things only a
// real database can: that `reserved` comes back carrying the gap the trigger folded in,
// and that search and the exclusion constraint agree about which rows occupy time.
//
// Needs DATABASE_URL. See test/db/schema.test.ts for how to get one.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { handleAvailability } from '../../src/api/availability.ts';
import { loadAvailabilityRules, loadReservedRanges } from '../../src/db/queries.ts';

const url = process.env.DATABASE_URL;
const db = new pg.Client({ connectionString: url });

// Friday 2026-11-20 is the reference day throughout. Alex works 18:00-22:00 Chicago,
// which in November (CST, -6) is 2026-11-21T00:00Z to 04:00Z.
const WINDOW = { from: '2026-11-16T00:00:00Z', to: '2026-11-23T00:00:00Z' };
const NOW = new Date('2026-11-19T00:00:00Z');

interface Body {
  days?: { date: string; note?: string; slots: { start: string; end: string }[] }[];
}

const slotsOf = (body: unknown): string[] =>
  (body as Body).days?.flatMap((d) => d.slots.map((s) => s.start)) ?? [];

async function reserve(startIso: string, endIso: string, kind = 'booking') {
  const { rows } = await db.query(
    'INSERT INTO reservations (kind, starts_at, ends_at) VALUES ($1, $2, $3) RETURNING id',
    [kind, startIso, endIso],
  );
  return (rows[0] as { id: string }).id;
}

describe('availability search against the database', () => {
  before(async () => {
    assert.ok(url, 'DATABASE_URL must be set');
    await db.connect();
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'availability_rules'`,
    );
    assert.equal(rows.length, 1, 'run `npm run migrate` first');
  });
  after(async () => { await db.end(); });

  beforeEach(async () => {
    await db.query('TRUNCATE reservations CASCADE');
    await db.query('TRUNCATE availability_rules');
    await db.query(
      `INSERT INTO availability_rules (weekday, start_local, end_local, tz)
       VALUES (5, '18:00', '22:00', 'America/Chicago')`,
    );
  });

  test('a time column round-trips into a rule the search can expand', async () => {
    const rules = await loadAvailabilityRules(db);
    assert.deepEqual(rules, [
      { weekday: 5, startLocal: '18:00:00', endLocal: '22:00:00', tz: 'America/Chicago' },
    ]);
  });

  test('reserved ranges come back carrying the gap the trigger added', async () => {
    await reserve('2026-11-21T01:00:00Z', '2026-11-21T02:00:00Z');
    const ranges = await loadReservedRanges(db, {
      start: new Date(WINDOW.from), end: new Date(WINDOW.to),
    });
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.start.toISOString(), '2026-11-21T01:00:00.000Z');
    assert.equal(ranges[0]?.end.toISOString(), '2026-11-21T02:15:00.000Z',
      'the 15-minute gap must arrive with the row, not be re-derived by the caller');
  });

  test('an empty calendar offers the whole evening on the grid', async () => {
    const r = await handleAvailability(db, { ...WINDOW, sku: 'live_coaching', tz: 'UTC' }, NOW);
    const slots = slotsOf(r.body);
    assert.equal(r.status, 200);
    assert.equal(slots[0], '2026-11-21T00:00:00.000Z', '18:00 Chicago');
    assert.equal(slots.at(-1), '2026-11-21T03:00:00.000Z', '21:00 Chicago, the last sellable hour');
  });

  test('a booking removes its hour and the gap after it', async () => {
    await reserve('2026-11-21T00:00:00Z', '2026-11-21T01:00:00Z');
    const r = await handleAvailability(db, { ...WINDOW, sku: 'live_coaching', tz: 'UTC' }, NOW);
    const slots = slotsOf(r.body);
    assert.equal(slots.includes('2026-11-21T00:00:00.000Z'), false, 'the booked hour is gone');
    assert.equal(slots.includes('2026-11-21T01:00:00.000Z'), false, 'inside the gap');
    assert.equal(slots[0], '2026-11-21T01:15:00.000Z', 'the first instant the constraint accepts');
  });

  test('every offered slot is one the exclusion constraint actually accepts', async () => {
    // The strongest assertion in this file: search and the database must agree. If they
    // disagree the student sees "that time is no longer available" on a free evening.
    await reserve('2026-11-21T01:00:00Z', '2026-11-21T02:00:00Z');
    const r = await handleAvailability(db, { ...WINDOW, sku: 'live_coaching', tz: 'UTC' }, NOW);
    const slots = slotsOf(r.body);
    assert.ok(slots.length > 0, 'there must be something to check');

    // Each probe inserts for real and is rolled back, so the constraint is the judge
    // rather than a reimplementation of it in the test.
    const refused: string[] = [];
    await db.query('BEGIN');
    try {
      for (const start of slots) {
        const end = new Date(new Date(start).getTime() + 60 * 60_000).toISOString();
        await db.query('SAVEPOINT probe');
        try {
          await reserve(start, end);
        } catch (err) {
          refused.push(`${start} (${(err as Error).message})`);
        }
        await db.query('ROLLBACK TO SAVEPOINT probe');
      }
    } finally {
      await db.query('ROLLBACK');
    }
    assert.deepEqual(refused, [], 'search offered times the database refuses');
  });

  test('a blackout is subtracted exactly like a booking', async () => {
    await reserve('2026-11-21T00:00:00Z', '2026-11-21T04:00:00Z', 'blackout');
    const r = await handleAvailability(db, { ...WINDOW, sku: 'live_coaching', tz: 'UTC' }, NOW);
    assert.deepEqual(slotsOf(r.body), [], 'a blacked-out evening sells nothing');
  });

  test('releasing a hold puts the time back on sale', async () => {
    const id = await reserve('2026-11-21T00:00:00Z', '2026-11-21T01:00:00Z');
    const before = slotsOf((await handleAvailability(
      db, { ...WINDOW, sku: 'live_coaching', tz: 'UTC' }, NOW)).body);
    assert.equal(before.includes('2026-11-21T00:00:00.000Z'), false);

    // The booking state machine clears holds_slot when a hold lapses or is cancelled.
    await db.query('UPDATE reservations SET holds_slot = false WHERE id = $1', [id]);
    const after = slotsOf((await handleAvailability(
      db, { ...WINDOW, sku: 'live_coaching', tz: 'UTC' }, NOW)).body);
    assert.equal(after.includes('2026-11-21T00:00:00.000Z'), true,
      'search must use the same holds_slot predicate as the constraint');
  });

  describe('the Both SKU', () => {
    test('finds no two-hour block once the evening is split in the middle', async () => {
      await reserve('2026-11-21T01:30:00Z', '2026-11-21T02:30:00Z');
      const r = await handleAvailability(db, { ...WINDOW, sku: 'both', tz: 'UTC' }, NOW);
      const day = (r.body as Body).days?.find((d) => d.date === '2026-11-21');
      assert.deepEqual(day?.slots, []);
      assert.equal(day?.note, 'No continuous 2-hour blocks on this day.');
    });

    test('still sells a one-hour SKU on that same split evening', async () => {
      await reserve('2026-11-21T01:30:00Z', '2026-11-21T02:30:00Z');
      const r = await handleAvailability(db, { ...WINDOW, sku: 'vod_review', tz: 'UTC' }, NOW);
      assert.ok(slotsOf(r.body).length > 0);
    });

    test('offers the block when the evening is clear', async () => {
      const r = await handleAvailability(db, { ...WINDOW, sku: 'both', tz: 'UTC' }, NOW);
      const slots = slotsOf(r.body);
      assert.equal(slots[0], '2026-11-21T00:00:00.000Z');
      assert.equal(slots.at(-1), '2026-11-21T02:00:00.000Z', '20:00 Chicago, ending at 22:00');
    });
  });
});
