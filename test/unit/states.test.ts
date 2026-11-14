import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKING_EDGES,
  ENTITLEMENT_EDGES,
  IllegalTransition,
  bookingTransition,
  entitlementTransition,
  holdsSlot,
} from '../../src/states.ts';

describe('booking state machine', () => {
  test('every declared edge is permitted by its declared writer', () => {
    for (const e of BOOKING_EDGES) {
      assert.equal(bookingTransition(e.from, e.to, e.by), e.to, `${e.from} -> ${e.to}`);
    }
  });

  test('the right writer matters: the cancel path cannot close a window', () => {
    assert.throws(() => bookingTransition('active', 'completed', 'cancel_path'), IllegalTransition);
  });

  test('a terminal booking cannot be moved', () => {
    for (const to of ['paid', 'active', 'cancelled'] as const) {
      assert.throws(
        () => bookingTransition('completed', to, 'poller_window_close'),
        IllegalTransition,
        `completed -> ${to}`,
      );
    }
  });

  test('cancellation is impossible once the window has opened', () => {
    assert.throws(() => bookingTransition('active', 'cancelled', 'cancel_path'), IllegalTransition);
  });

  test('expired_hold is not terminal: the race moves out of it both ways', () => {
    assert.equal(bookingTransition('expired_hold', 'paid', 'webhook_handler'), 'paid');
    assert.equal(
      bookingTransition('expired_hold', 'payment_orphaned', 'webhook_handler'),
      'payment_orphaned',
    );
  });
});

describe('entitlement state machine', () => {
  test('every declared edge is permitted by its declared writer', () => {
    for (const e of ENTITLEMENT_EDGES) {
      assert.equal(entitlementTransition(e.from, e.to, e.by), e.to, `${e.from} -> ${e.to}`);
    }
  });

  test('there is no revoked state and nothing can cut access short', () => {
    // `revoked` was deleted with the no-refund decision: no writer existed for it.
    assert.throws(
      // @ts-expect-error 'revoked' is not an EntitlementState, which is the assertion
      () => entitlementTransition('open', 'revoked', 'poller_window_close'),
      IllegalTransition,
    );
  });

  test('a window that never opened can still be resolved as a platform failure', () => {
    assert.equal(
      entitlementTransition('pending', 'expired_unfulfilled', 'poller_window_close'),
      'expired_unfulfilled',
    );
  });
});

describe('holdsSlot', () => {
  test('a lapsed hold and a cancellation release the slot', () => {
    assert.equal(holdsSlot('expired_hold'), false);
    assert.equal(holdsSlot('cancelled'), false);
    assert.equal(holdsSlot('payment_orphaned'), false);
  });

  test('a delivered or undelivered session still consumed its time', () => {
    assert.equal(holdsSlot('completed'), true);
    assert.equal(holdsSlot('completed_unfulfilled'), true);
  });
});
