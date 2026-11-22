// The Stripe side of the outbound boundary: one implementation of PaymentProvider.
//
// This file and ./verifier.ts are the only two in src/ that import the Stripe SDK. If a
// third appears, the boundary has leaked and the write path is no longer testable
// without an account.

import Stripe from 'stripe';
import type { CheckoutSession, CheckoutSessionInput, PaymentProvider } from '../payments.ts';
import { PaymentProviderError } from '../payments.ts';
import { SKUS } from '../skus.ts';

/**
 * Stripe enforces a 30-minute minimum on `expires_at`, measured from session creation.
 * Asking for exactly 1800 seconds is refused if a second elapses between computing the
 * timestamp and Stripe reading it, so this asks for a minute more.
 */
export const SESSION_LIFETIME_MINUTES = 31;

/**
 * Pinned rather than inherited from the SDK default, so upgrading `stripe` cannot change
 * the shape of what Stripe sends back without the change being visible here.
 */
export const STRIPE_API_VERSION = '2026-11-18.endive';

/** Labels these sessions in the Dashboard so this flow can be compared against others. */
export const INTEGRATION_IDENTIFIER = 'lolcoach-booking-hqvdmwrk';

export interface StripeProviderConfig {
  secretKey: string;
  /** Where Stripe returns the student after paying, and after backing out. */
  successUrl: string;
  cancelUrl: string;
}

export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe;
  private readonly config: StripeProviderConfig;

  constructor(config: StripeProviderConfig, stripe?: Stripe) {
    this.config = config;
    this.stripe = stripe ?? new Stripe(config.secretKey, { apiVersion: STRIPE_API_VERSION });
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const sku = SKUS[input.sku];
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MINUTES * 60_000);

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          customer_email: input.email,
          // Inline price rather than a Stripe Price object, so skus.ts stays the single
          // source of truth. A Price in the dashboard could drift from the booking row.
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'usd',
                unit_amount: input.priceCents,
                product_data: { name: sku.label },
              },
            },
          ],
          // The thread back to our database. The webhook reads this to learn which
          // booking was paid for; without it a completed session is an anonymous
          // "someone paid $40".
          metadata: { bookingId: input.bookingId },
          expires_at: Math.floor(expiresAt.getTime() / 1000),
          integration_identifier: INTEGRATION_IDENTIFIER,
          success_url: this.config.successUrl,
          cancel_url: this.config.cancelUrl,
        },
        {
          // The SDK retries by itself on a network error. Without a key, a retry whose
          // first attempt actually reached Stripe creates a SECOND payable session for
          // one booking. With it, the retry returns the original.
          idempotencyKey: `booking-${input.bookingId}`,
        },
      );
    } catch (err) {
      throw new PaymentProviderError('Stripe refused the Checkout session', err);
    }

    if (session.url === null) {
      // Only happens for `ui_mode: 'embedded'`, which this does not use. Treated as a
      // failure rather than returning an unusable hold.
      throw new PaymentProviderError(`Stripe session ${session.id} has no redirect URL`);
    }

    return {
      sessionId: session.id,
      url: session.url,
      // Stripe echoes the expiry it actually applied. Trusting its value rather than
      // the one requested keeps hold_expires_at honest if Stripe clamps it.
      expiresAt: new Date(session.expires_at * 1000),
    };
  }
}
