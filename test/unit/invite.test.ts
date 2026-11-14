import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideInviteMaxAge, DISCORD_MAX_AGE_CEILING_SECONDS } from '../../src/invite.ts';

const at = (iso: string) => new Date(iso);

describe('invite max_age', () => {
  test('a full hour at window open', () => {
    const d = decideInviteMaxAge(at('2026-11-20T15:00:00Z'), at('2026-11-20T14:00:00Z'));
    assert.deepEqual(d, { create: true, maxAgeSeconds: 3600 });
  });

  test('a two-hour Both booking', () => {
    const d = decideInviteMaxAge(at('2026-11-20T16:00:00Z'), at('2026-11-20T14:00:00Z'));
    assert.deepEqual(d, { create: true, maxAgeSeconds: 7200 });
  });

  test('exactly at ends_at: create nothing', () => {
    const d = decideInviteMaxAge(at('2026-11-20T15:00:00Z'), at('2026-11-20T15:00:00Z'));
    assert.deepEqual(d, { create: false, reason: 'window_over' });
  });

  test('a poller running late must never mint max_age 0, which means never expires', () => {
    const d = decideInviteMaxAge(at('2026-11-20T15:00:00Z'), at('2026-11-20T15:30:00Z'));
    assert.deepEqual(d, { create: false, reason: 'window_over' });
  });

  test('sub-minute remainder is honoured exactly, never rounded up', () => {
    const d = decideInviteMaxAge(at('2026-11-20T15:00:00Z'), at('2026-11-20T14:59:50Z'));
    assert.deepEqual(d, { create: true, maxAgeSeconds: 10 });
  });

  test('the invariant: an issued code never outlives its window', () => {
    const endsAt = at('2026-11-20T15:00:00Z');
    for (const offsetMs of [1_000, 10_000, 59_999, 60_000, 3_600_000]) {
      const now = new Date(endsAt.getTime() - offsetMs);
      const d = decideInviteMaxAge(endsAt, now);
      assert.equal(d.create, true, `offset ${offsetMs}`);
      if (d.create) {
        const expiry = now.getTime() + d.maxAgeSeconds * 1000;
        assert.ok(expiry <= endsAt.getTime(), `expiry ${expiry} must be <= ${endsAt.getTime()}`);
      }
    }
  });

  test('never exceeds Discord ceiling', () => {
    const d = decideInviteMaxAge(at('2027-01-01T00:00:00Z'), at('2026-11-20T00:00:00Z'));
    assert.equal(d.create && d.maxAgeSeconds, DISCORD_MAX_AGE_CEILING_SECONDS);
  });
});
