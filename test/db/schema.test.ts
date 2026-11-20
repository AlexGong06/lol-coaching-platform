// Database behavior, against a real PostgreSQL. These assert things a double cannot
// prove: that the exclusion constraint compiles at all, and that it refuses what the
// design claims it refuses.
//
// Needs DATABASE_URL. Any PostgreSQL 16+ will do:
//   docker compose up -d db          (or)   brew install postgresql@16
//   npm run migrate && npm run test:db
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const url = process.env.DATABASE_URL;
const db = new pg.Client({ connectionString: url });

// A fixed Friday, so nothing depends on when the suite runs.
const H = (hhmm: string) => `2026-11-20T${hhmm}:00Z`;

async function reserve(startHHMM: string, endHHMM: string, kind = 'booking') {
  return db.query(
    'INSERT INTO reservations (kind, starts_at, ends_at) VALUES ($1, $2, $3) RETURNING id, reserved',
    [kind, H(startHHMM), H(endHHMM)],
  );
}

const isOverlapViolation = (err: unknown) =>
  (err as { code?: string }).code === '23P01' &&
  String((err as { constraint?: string }).constraint) === 'reservations_no_overlap';

describe('reservations: overlap, the gap, and blackouts', () => {
  before(async () => {
    assert.ok(url, 'DATABASE_URL must be set');
    await db.connect();
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'reservations'`,
    );
    assert.equal(rows.length, 1, 'run `npm run migrate` first');
  });
  after(async () => { await db.end(); });
  beforeEach(async () => { await db.query('TRUNCATE reservations CASCADE'); });

  test('the trigger folds the 15-minute gap into the reserved range', async () => {
    const { rows } = await reserve('14:00', '15:00');
    // 2:00-3:00 reserves 2:00-3:15, so nothing may start before 3:15.
    assert.match(rows[0].reserved, /15:15:00/);
  });

  test('a duplicate booking of the same hour is refused by the database', async () => {
    await reserve('14:00', '15:00');
    await assert.rejects(() => reserve('14:00', '15:00'), isOverlapViolation);
  });

  test('a partially overlapping booking is refused', async () => {
    await reserve('14:00', '15:00');
    await assert.rejects(() => reserve('14:30', '15:30'), isOverlapViolation);
  });

  test('the 15-minute gap is enforced, not merely documented', async () => {
    await reserve('14:00', '15:00');
    // 3:05 is free of the session but inside its trailing gap.
    await assert.rejects(() => reserve('15:05', '16:05'), isOverlapViolation);
  });

  test('a booking exactly after the gap is accepted', async () => {
    await reserve('14:00', '15:00');
    const { rows } = await reserve('15:15', '16:15');
    assert.ok(rows[0].id);
  });

  test('a blackout refuses an overlapping booking, by the same constraint', async () => {
    // This is the assertion the previous design could not satisfy: it put blackouts in
    // their own table, and a PostgreSQL exclusion constraint builds a single-table
    // index and can never see a row elsewhere.
    await reserve('09:00', '17:00', 'blackout');
    await assert.rejects(() => reserve('14:00', '15:00'), isOverlapViolation);
  });

  test('a booking refuses an overlapping blackout, symmetrically', async () => {
    await reserve('14:00', '15:00');
    await assert.rejects(() => reserve('13:00', '18:00', 'blackout'), isOverlapViolation);
  });

  test('releasing the slot lets the time be rebooked', async () => {
    const { rows } = await reserve('14:00', '15:00');
    await assert.rejects(() => reserve('14:00', '15:00'), isOverlapViolation);
    // A lapsed hold or a cancellation clears holds_slot rather than deleting history.
    await db.query('UPDATE reservations SET holds_slot = false WHERE id = $1', [rows[0].id]);
    const second = await reserve('14:00', '15:00');
    assert.ok(second.rows[0].id);
  });

  describe('the Both SKU needs two contiguous hours plus the gap', () => {
    test('refused when it would span an existing 1-hour booking', async () => {
      await reserve('15:00', '16:00');
      await assert.rejects(() => reserve('14:00', '16:00'), isOverlapViolation);
    });

    test('accepted into a clear 2-hour-plus-gap opening', async () => {
      await reserve('09:00', '10:00');            // reserves 09:00-10:15
      const { rows } = await reserve('10:15', '12:15'); // 2h, starting exactly after the gap
      assert.ok(rows[0].id);
    });

    test('refused when the opening is 2 hours but the trailing gap collides', async () => {
      await reserve('09:00', '10:00');   // reserves 09:00-10:15
      await reserve('12:20', '13:20');   // reserves 12:20-13:35
      // 10:15-12:15 fits, but its own gap runs to 12:30 and collides with 12:20.
      await assert.rejects(() => reserve('10:15', '12:15'), isOverlapViolation);
    });
  });

  // Every malformed range must fail the SAME way. Before the trigger guarded this, the
  // error code depended on how backwards the range was: a BEFORE trigger runs ahead of
  // every CHECK, so a range backwards by more than the 15-minute gap died inside
  // tstzrange() as 22000, while one backwards by less than the gap shifted into a valid
  // range and fell through to the CHECK as 23514. Calling code cannot catch both.
  describe('a malformed range is refused with one error code', () => {
    const isCheckViolation = (err: unknown) => (err as { code?: string }).code === '23514';

    test('backwards by more than the 15-minute gap', async () => {
      await assert.rejects(() => reserve('15:00', '14:00'), isCheckViolation);
    });

    test('backwards by less than the 15-minute gap', async () => {
      await assert.rejects(() => reserve('15:00', '14:50'), isCheckViolation);
    });

    test('zero-length', async () => {
      await assert.rejects(() => reserve('15:00', '15:00'), isCheckViolation);
    });
  });

  test('a NULL reserved range cannot slip past the exclusion constraint', async () => {
    // `&&` against NULL yields NULL, not true, so a NULL-reserved row would be
    // invisible to the constraint and double-book its time. The trigger always fills
    // the column, so this disables it to reach the state a COPY or a replication tool
    // could otherwise produce. NOT NULL is what actually holds the line.
    await db.query('ALTER TABLE reservations DISABLE TRIGGER reservations_reserved');
    try {
      await assert.rejects(
        () => db.query(
          `INSERT INTO reservations (kind, starts_at, ends_at, reserved)
           VALUES ('booking', $1, $2, NULL)`,
          [H('14:00'), H('15:00')],
        ),
        (err: unknown) => (err as { code?: string }).code === '23502',
      );
    } finally {
      await db.query('ALTER TABLE reservations ENABLE TRIGGER reservations_reserved');
    }
  });
});
