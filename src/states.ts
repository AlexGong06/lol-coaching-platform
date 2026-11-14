// The booking and entitlement state machines, as the single source of truth.
//
// The design doc states every transition and its writer in two prose tables. Prose
// tables drift: four review rounds found transitions that were committed to in one
// section and absent from another, including the two that carry money. Here an
// illegal transition is a thrown error and an unlisted one is a type error, so the
// tables cannot disagree with the code that uses them.

export const BOOKING_STATES = [
  'pending_payment',
  'paid',
  'active',
  'completed',
  'completed_unfulfilled',
  'expired_hold',
  'payment_orphaned',
  'cancelled',
] as const;
export type BookingState = (typeof BOOKING_STATES)[number];

export const ENTITLEMENT_STATES = [
  'pending',
  'open',
  'closed',
  'voided',
  'expired_unfulfilled',
] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];

/** Who is allowed to perform a transition. Recorded so the audit trail can say. */
export type Writer =
  | 'booking_service'
  | 'webhook_handler'
  | 'poller_hold_expiry'
  | 'poller_window_open'
  | 'poller_window_close'
  | 'cancel_path';

type Edge<S extends string> = { from: S; to: S; by: Writer };

export const BOOKING_EDGES: readonly Edge<BookingState>[] = [
  { from: 'pending_payment', to: 'paid', by: 'webhook_handler' },
  { from: 'pending_payment', to: 'expired_hold', by: 'poller_hold_expiry' },
  { from: 'pending_payment', to: 'cancelled', by: 'cancel_path' },
  // Not terminal: the expired-hold race moves out of it in both directions.
  { from: 'expired_hold', to: 'paid', by: 'webhook_handler' },
  { from: 'expired_hold', to: 'payment_orphaned', by: 'webhook_handler' },
  { from: 'paid', to: 'active', by: 'poller_window_open' },
  { from: 'paid', to: 'cancelled', by: 'cancel_path' },
  // The poller missed window start entirely; the entitlement never left `pending`.
  { from: 'paid', to: 'completed_unfulfilled', by: 'poller_window_close' },
  { from: 'active', to: 'completed', by: 'poller_window_close' },
  { from: 'active', to: 'completed_unfulfilled', by: 'poller_window_close' },
];

export const ENTITLEMENT_EDGES: readonly Edge<EntitlementState>[] = [
  { from: 'pending', to: 'open', by: 'poller_window_open' },
  { from: 'pending', to: 'voided', by: 'cancel_path' },
  { from: 'pending', to: 'expired_unfulfilled', by: 'poller_window_close' },
  { from: 'open', to: 'closed', by: 'poller_window_close' },
  { from: 'open', to: 'expired_unfulfilled', by: 'poller_window_close' },
];

export const TERMINAL_BOOKING_STATES: readonly BookingState[] = [
  'completed',
  'completed_unfulfilled',
  'payment_orphaned',
  'cancelled',
];

export const TERMINAL_ENTITLEMENT_STATES: readonly EntitlementState[] = [
  'closed',
  'voided',
  'expired_unfulfilled',
];

export class IllegalTransition extends Error {
  // Plain fields, not parameter properties: tsconfig sets erasableSyntaxOnly so the
  // sources run directly under `node --test` with no build step.
  machine: 'booking' | 'entitlement';
  from: string;
  to: string;
  by: Writer;

  constructor(machine: 'booking' | 'entitlement', from: string, to: string, by: Writer) {
    super(`illegal ${machine} transition ${from} -> ${to} by ${by}`);
    this.name = 'IllegalTransition';
    this.machine = machine;
    this.from = from;
    this.to = to;
    this.by = by;
  }
}

function check<S extends string>(
  machine: 'booking' | 'entitlement',
  edges: readonly Edge<S>[],
  from: S,
  to: S,
  by: Writer,
): S {
  if (!edges.some((e) => e.from === from && e.to === to && e.by === by)) {
    throw new IllegalTransition(machine, from, to, by);
  }
  return to;
}

export const bookingTransition = (from: BookingState, to: BookingState, by: Writer): BookingState =>
  check('booking', BOOKING_EDGES, from, to, by);

export const entitlementTransition = (
  from: EntitlementState,
  to: EntitlementState,
  by: Writer,
): EntitlementState => check('entitlement', ENTITLEMENT_EDGES, from, to, by);

/** Whether a reservation row should still occupy its time, given the booking state. */
export const holdsSlot = (state: BookingState): boolean =>
  state === 'pending_payment' || state === 'paid' || state === 'active' ||
  state === 'completed' || state === 'completed_unfulfilled';
