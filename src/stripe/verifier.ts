// Signature verification, and the narrowing of a Stripe event to a PaymentEvent.

import Stripe from 'stripe';
import type { PaymentEvent, WebhookVerifier } from '../payments.ts';
import { WebhookVerificationError } from '../payments.ts';

export class StripeWebhookVerifier implements WebhookVerifier {
  private readonly stripe: Stripe;
  private readonly signingSecret: string;

  constructor(signingSecret: string, stripe?: Stripe) {
    this.signingSecret = signingSecret;
    // No API key needed: constructEvent is local HMAC work and never calls Stripe.
    this.stripe = stripe ?? new Stripe('sk_unused_for_verification_only');
  }

  /**
   * `rawBody` must be the exact bytes Stripe sent.
   *
   * Stripe HMACs the timestamp and the raw body. Parsing the JSON and re-serializing it
   * changes key order and whitespace, the HMAC no longer matches, and the tempting fix
   * is to stop verifying. In a Next.js route that means `await request.text()`, never
   * `await request.json()`.
   */
  verify(rawBody: string, signature: string): PaymentEvent {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.signingSecret);
    } catch (err) {
      // Covers a forged signature, a body that was parsed and re-serialized, and a
      // replay older than Stripe's tolerance window.
      throw new WebhookVerificationError('webhook signature did not verify', err);
    }

    const object = event.data.object as {
      id?: unknown;
      metadata?: { bookingId?: unknown } | null;
      payment_status?: unknown;
      amount_total?: unknown;
    };

    return {
      id: event.id,
      type: event.type,
      sessionId: typeof object.id === 'string' ? object.id : null,
      bookingId:
        typeof object.metadata?.bookingId === 'string' ? object.metadata.bookingId : null,
      paymentStatus: typeof object.payment_status === 'string' ? object.payment_status : null,
      amountTotalCents: typeof object.amount_total === 'number' ? object.amount_total : null,
    };
  }
}
