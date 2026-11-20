// A PaymentProvider that answers from memory, so the hold transaction can be driven
// into states Stripe will not produce on request.

import type { CheckoutSession, CheckoutSessionInput, PaymentProvider } from '../../src/payments.ts';
import { PaymentProviderError } from '../../src/payments.ts';

export interface FakeOptions {
  /** Minutes until the returned session expires. Stripe's floor is 30. */
  expiresInMinutes?: number;
  /** When set, every call rejects with a PaymentProviderError carrying this message. */
  failWith?: string;
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
    return {
      sessionId: `cs_test_fake_${input.bookingId}_${this.counter}`,
      url: `https://checkout.example/cs_test_fake_${input.bookingId}`,
      expiresAt: new Date(Date.now() + minutes * 60_000),
    };
  }
}
