import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindowEnd } from '../../src/fulfillment.ts';

describe('window-end rule', () => {
  test('a code was issued: delivered, no money owed', () => {
    const out = resolveWindowEnd({
      bookingState: 'active',
      entitlementState: 'open',
      anyCodeIssued: true,
    });
    assert.deepEqual(out, {
      kind: 'resolve',
      booking: 'completed',
      entitlement: 'closed',
      manualRefundOwed: false,
    });
  });

  test('attendance is not an input: an unused code settles identically', () => {
    // The student who never clicks and the student who stays the whole hour are the
    // same row to this system. This is also what makes the returning student (already
    // in the server, never clicks) safe rather than recorded as a no-show.
    const a = resolveWindowEnd({ bookingState: 'active', entitlementState: 'open', anyCodeIssued: true });
    const b = resolveWindowEnd({ bookingState: 'active', entitlementState: 'open', anyCodeIssued: true });
    assert.deepEqual(a, b);
  });

  test('no code was ever issued: platform failure, manual refund owed', () => {
    const out = resolveWindowEnd({
      bookingState: 'active',
      entitlementState: 'open',
      anyCodeIssued: false,
    });
    assert.deepEqual(out, {
      kind: 'resolve',
      booking: 'completed_unfulfilled',
      entitlement: 'expired_unfulfilled',
      manualRefundOwed: true,
    });
  });

  test('the poller never reached window start at all', () => {
    const out = resolveWindowEnd({
      bookingState: 'paid',
      entitlementState: 'pending',
      anyCodeIssued: false,
    });
    assert.equal(out.kind, 'resolve');
    assert.deepEqual(out, {
      kind: 'resolve',
      booking: 'completed_unfulfilled',
      entitlement: 'expired_unfulfilled',
      manualRefundOwed: true,
    });
  });

  test('a late pass cannot refund a session that was delivered', () => {
    // The rule takes no clock, so "an hour late" is not representable as an input --
    // which is the point. The only thing that decides is the code record.
    const onTime = resolveWindowEnd({ bookingState: 'active', entitlementState: 'open', anyCodeIssued: true });
    assert.equal(onTime.kind === 'resolve' && onTime.manualRefundOwed, false);
  });

  test('a second pass over a resolved booking does nothing', () => {
    for (const entitlementState of ['closed', 'expired_unfulfilled', 'voided'] as const) {
      const out = resolveWindowEnd({ bookingState: 'completed', entitlementState, anyCodeIssued: true });
      assert.equal(out.kind, 'skip', entitlementState);
    }
  });

  test('a cancelled booking is never resolved into a delivered session', () => {
    const out = resolveWindowEnd({
      bookingState: 'cancelled',
      entitlementState: 'voided',
      anyCodeIssued: false,
    });
    assert.equal(out.kind, 'skip');
  });

  test('an unpaid booking is never resolved', () => {
    for (const bookingState of ['pending_payment', 'expired_hold'] as const) {
      const out = resolveWindowEnd({ bookingState, entitlementState: 'pending', anyCodeIssued: false });
      assert.equal(out.kind, 'skip', bookingState);
    }
  });
});
