// The payment provider boundary.
//
// Stripe is not imported here or anywhere on the write path. `createHold` takes a
// PaymentProvider, which buys two things:
//
//   1. The hold transaction is testable with no Stripe account, no network and no
//      webhook tunnel, so the money-critical logic landed before the integration did.
//   2. The two failures that actually lose money become reproducible on demand: the
//      provider throwing after the slot is reserved, and the provider succeeding while
//      the transaction cannot commit. Neither can be provoked against a real test
//      account, which is why they are usually discovered in production.
//
// The Stripe adapter implements this interface and changes nothing else.

import type { Sku } from './skus.ts';

export interface CheckoutSessionInput {
  /** bigserial, which node-postgres returns as a string. Used as the Stripe metadata key. */
  bookingId: string;
  sku: Sku;
  /** Passed explicitly rather than re-derived from the SKU, so the row and the charge agree. */
  priceCents: number;
  email: string;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
  /**
   * When the provider stops accepting payment. Stripe enforces a 30-minute minimum
   * measured from session creation, which is why the hold cannot be taken when the
   * student picks a slot: it would expire while they filled in the form.
   */
  expiresAt: Date;
}

export interface PaymentProvider {
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>;
}

/**
 * Thrown by an adapter when the provider could not be reached or refused the request.
 * `createHold` lets this roll the transaction back rather than retrying: a retry would
 * hold the reservation row's lock for a second network round trip, and the student is
 * waiting on an HTTP response.
 */
export class PaymentProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    // Error's own `cause` option, rather than a field: declaring one would shadow the
    // base member and `noImplicitOverride` rejects it.
    super(message, { cause });
    this.name = 'PaymentProviderError';
  }
}
