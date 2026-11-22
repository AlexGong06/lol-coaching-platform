// A PaymentProvider that answers from memory, so the hold transaction can be driven
// into states Stripe will not produce on request.

import type {
  CheckoutSession, CheckoutSessionInput, PaymentEvent, PaymentProvider, WebhookVerifier,
} from '../../src/payments.ts';
import { PaymentProviderError, WebhookVerificationError } from '../../src/payments.ts';

export interface FakeOptions {
  /** Minutes until the returned session expires. Stripe's floor is 30. */
  expiresInMinutes?: number;
  /** When set, every call rejects with a PaymentProviderError carrying this message. */
  failWith?: string;
  /**
   * The instant expiry is measured from. Defaults to the wall clock, which is wrong for
   * any test that then feeds holdExpiresAt back in as its own `now`: the hold would
   * expire relative to today rather than to the test's fixed date.
   */
  now?: Date;
}

export class FakePaymentProvider implements PaymentProvider {
  calls: CheckoutSessionInput[] = [];
  private readonly options: FakeOptions;
  private counter = 0;

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    this.calls.push(input);
    if (this.options.failWith !== undefined) {
      throw new PaymentProviderError(this.options.failWith);
    }
    this.counter += 1;
    const minutes = this.options.expiresInMinutes ?? 30;
    const from = this.options.now ?? new Date();
    return {
      sessionId: `cs_test_fake_${input.bookingId}_${this.counter}`,
      url: `https://checkout.example/cs_test_fake_${input.bookingId}`,
      expiresAt: new Date(from.getTime() + minutes * 60_000),
    };
  }
}

/**
 * A verifier that accepts one fixed signature and reads the event straight out of the
 * body. Tests can then hand the handler any PaymentEvent without computing an HMAC.
 */
export class FakeWebhookVerifier implements WebhookVerifier {
  static readonly VALID_SIGNATURE = 'test-signature';

  verify(rawBody: string, signature: string): PaymentEvent {
    if (signature !== FakeWebhookVerifier.VALID_SIGNATURE) {
      throw new WebhookVerificationError('fake verifier rejected the signature');
    }
    return JSON.parse(rawBody) as PaymentEvent;
  }
}

let eventCounter = 0;

/** A `checkout.session.completed` for a paid session, with fields overridable. */
export function paymentEvent(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  eventCounter += 1;
  return {
    id: `evt_test_${eventCounter}`,
    type: 'checkout.session.completed',
    sessionId: 'cs_test_fake',
    bookingId: null,
    paymentStatus: 'paid',
    amountTotalCents: 4000,
    ...overrides,
  };
}
