// The window-end rule, as a pure function.
//
// This is the decision with money attached, and the design doc got it wrong twice:
// first by keying it on whether the student was observed to join (unobservable: Discord
// deletes a max_uses:1 invite on use, so joined/deleted/expired are indistinguishable),
// then by leaving "drives the entitlement to its terminal state" ambiguous between two
// states with opposite financial effects.
//
// It takes NO clock. That is the fix. A pass that runs on time and a pass that runs an
// hour late after a crash or a deploy get the same answer, because the answer depends
// only on whether a code was ever issued.

import {
  type BookingState,
  type EntitlementState,
  TERMINAL_BOOKING_STATES,
  TERMINAL_ENTITLEMENT_STATES,
  bookingTransition,
  entitlementTransition,
} from './states.ts';

export type WindowEndInput = {
  bookingState: BookingState;
  entitlementState: EntitlementState;
  /** Did any access_invites row for this entitlement ever reach `issued`? */
  anyCodeIssued: boolean;
};

export type WindowEndOutcome =
  | { kind: 'skip'; reason: string }
  | {
      kind: 'resolve';
      booking: BookingState;
      entitlement: EntitlementState;
      /**
       * True when the platform took money and delivered nothing. Flags a red row in
       * /ops for Alex to refund by hand in the Stripe dashboard. NO code in this
       * system calls Stripe's refund API.
       */
      manualRefundOwed: boolean;
    };

export function resolveWindowEnd(input: WindowEndInput): WindowEndOutcome {
  const { bookingState, entitlementState, anyCodeIssued } = input;

  // Idempotent by construction: a duplicate or very late pass over an already-resolved
  // booking does nothing. This is what stops a three-week-old chargeback or a retried
  // due-work row from rewriting a finished session.
  if (TERMINAL_ENTITLEMENT_STATES.includes(entitlementState)) {
    return { kind: 'skip', reason: `entitlement already terminal (${entitlementState})` };
  }
  if (TERMINAL_BOOKING_STATES.includes(bookingState)) {
    return { kind: 'skip', reason: `booking already terminal (${bookingState})` };
  }

  // A cancelled booking's window_open/window_close rows are deleted in the cancel
  // transaction, so this should be unreachable. Defensive: if one survives, it must
  // not resolve a cancelled booking into a delivered session.
  if (bookingState === 'expired_hold' || bookingState === 'pending_payment') {
    return { kind: 'skip', reason: `never paid (${bookingState})` };
  }

  if (anyCodeIssued) {
    // A window was sold and a working credential was delivered. Whether the student
    // used it is not knowable and not relevant: no refund, no branch.
    return {
      kind: 'resolve',
      booking: bookingTransition(bookingState, 'completed', 'poller_window_close'),
      entitlement: entitlementTransition(entitlementState, 'closed', 'poller_window_close'),
      manualRefundOwed: false,
    };
  }

  // No code ever existed, so the student could not have got in however hard they tried.
  // The only platform-failure path in the system.
  return {
    kind: 'resolve',
    booking: bookingTransition(bookingState, 'completed_unfulfilled', 'poller_window_close'),
    entitlement: entitlementTransition(
      entitlementState,
      'expired_unfulfilled',
      'poller_window_close',
    ),
    manualRefundOwed: true,
  };
}
