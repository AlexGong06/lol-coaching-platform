// The two files that touch the Stripe SDK, tested with the SDK stubbed out.
//
// No account, no network, no signing secret. What these assert is the wiring that would
// otherwise only be discovered in production: that the booking id reaches the session
// metadata (without it a completed payment cannot be matched to a booking), that the
// price comes from skus.ts, and that a null URL or an SDK throw becomes a
// PaymentProviderError instead of a half-built hold.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { SESSION_LIFETIME_MINUTES, StripePaymentProvider } from '../../src/stripe/provider.ts';
import { StripeWebhookVerifier } from '../../src/stripe/verifier.ts';
import { PaymentProviderError, WebhookVerificationError } from '../../src/payments.ts';

const CONFIG = {
  secretKey: 'sk_test_not_a_real_key',
  successUrl: 'http://localhost:3000/booking/success',
  cancelUrl: 'http://localhost:3000/booking/cancelled',
};

const INPUT = {
  bookingId: '22',
  sku: 'live_coaching' as const,
  priceCents: 4000,
  email: 'student@example.com',
};

/** Records what the adapter asked Stripe for, and answers with `session`. */
function stubStripe(session: unknown, throws?: Error) {
  const created: { params: unknown; options: unknown }[] = [];
  const stripe = {
    checkout: {
      sessions: {
        async create(params: unknown, options: unknown) {
          created.push({ params, options });
          if (throws) throw throws;
          return session;
        },
      },
    },
  };
  return { created, stripe: stripe as unknown as Stripe };
}

const session = (overrides: Record<string, unknown> = {}) => ({
  id: 'cs_test_123',
  url: 'https://checkout.stripe.com/c/pay/cs_test_123',
  expires_at: Math.floor(new Date('2026-11-20T18:31:00Z').getTime() / 1000),
  ...overrides,
});

describe('StripePaymentProvider', () => {
  test('the booking id is carried in metadata, which is the thread back to our database', async () => {
    const stub = stubStripe(session());
    await new StripePaymentProvider(CONFIG, stub.stripe).createCheckoutSession(INPUT);

    const params = stub.created[0]?.params as { metadata: { bookingId: string } };
    assert.deepEqual(params.metadata, { bookingId: '22' });
  });

  test('the price and label come from the SKU table, not from the dashboard', async () => {
    const stub = stubStripe(session());
    await new StripePaymentProvider(CONFIG, stub.stripe).createCheckoutSession(INPUT);

    const params = stub.created[0]?.params as {
      mode: string;
      customer_email: string;
      line_items: { quantity: number; price_data: Record<string, unknown> }[];
    };
    assert.equal(params.mode, 'payment');
    assert.equal(params.customer_email, 'student@example.com');
    assert.deepEqual(params.line_items, [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: 4000,
          product_data: { name: 'Live Coaching' },
        },
      },
    ]);
  });

  test('expiry is requested past Stripe 30-minute floor, in whole seconds', async () => {
    const stub = stubStripe(session());
    const before = Math.floor(Date.now() / 1000);
    await new StripePaymentProvider(CONFIG, stub.stripe).createCheckoutSession(INPUT);

    const { expires_at } = stub.created[0]?.params as { expires_at: number };
    assert.ok(Number.isInteger(expires_at), 'Stripe takes a Unix timestamp, not millis');
    const minutesOut = (expires_at - before) / 60;
    assert.ok(minutesOut > 30, `must clear the 30-minute floor, asked for ${minutesOut}`);
    assert.ok(minutesOut <= SESSION_LIFETIME_MINUTES + 0.1);
  });

  test('the expiry returned is the one Stripe applied, not the one requested', async () => {
    // If Stripe ever clamps the request, hold_expires_at has to follow it or the
    // countdown on the booking page outlives the session it is counting.
    const applied = Math.floor(new Date('2026-12-01T00:00:00Z').getTime() / 1000);
    const stub = stubStripe(session({ expires_at: applied }));
    const result = await new StripePaymentProvider(CONFIG, stub.stripe).createCheckoutSession(INPUT);

    assert.equal(result.expiresAt.toISOString(), '2026-12-01T00:00:00.000Z');
    assert.equal(result.sessionId, 'cs_test_123');
    assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
  });

  test('a retry cannot create two payable sessions for one booking', async () => {
    const stub = stubStripe(session());
    await new StripePaymentProvider(CONFIG, stub.stripe).createCheckoutSession(INPUT);

    const options = stub.created[0]?.options as { idempotencyKey: string };
    assert.equal(options.idempotencyKey, 'booking-22');
  });

  test('an SDK failure becomes a PaymentProviderError, which rolls the hold back', async () => {
    const stub = stubStripe(session(), new Error('ECONNRESET'));
    await assert.rejects(
      () => new StripePaymentProvider(CONFIG, stub.stripe).createCheckoutSession(INPUT),
      (err: unknown) => err instanceof PaymentProviderError,
    );
  });

  test('a session with no redirect URL is a failure, not an unusable hold', async () => {
    const stub = stubStripe(session({ url: null }));
    await assert.rejects(
      () => new StripePaymentProvider(CONFIG, stub.stripe).createCheckoutSession(INPUT),
      (err: unknown) => err instanceof PaymentProviderError && /no redirect URL/.test(err.message),
    );
  });
});

/** Records the three arguments Stripe's HMAC check is given. */
function stubVerifier(event: unknown, throws?: Error) {
  const seen: { body: string; signature: string; secret: string }[] = [];
  const stripe = {
    webhooks: {
      constructEvent(body: string, signature: string, secret: string) {
        seen.push({ body, signature, secret });
        if (throws) throw throws;
        return event;
      },
    },
  };
  return { seen, stripe: stripe as unknown as Stripe };
}

describe('StripeWebhookVerifier', () => {
  const completed = {
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        metadata: { bookingId: '22' },
        payment_status: 'paid',
        amount_total: 4000,
      },
    },
  };

  test('the raw body is passed through untouched', async () => {
    // Re-serializing the JSON changes key order and whitespace, the HMAC stops matching,
    // and the tempting fix is to stop verifying.
    const raw = '{"id":"evt_test_1",  "type":"checkout.session.completed"}';
    const stub = stubVerifier(completed);
    new StripeWebhookVerifier('whsec_test', stub.stripe).verify(raw, 't=1,v1=abc');

    assert.deepEqual(stub.seen, [{ body: raw, signature: 't=1,v1=abc', secret: 'whsec_test' }]);
  });

  test('a verified event is narrowed to the fields the handler acts on', async () => {
    const stub = stubVerifier(completed);
    const event = new StripeWebhookVerifier('whsec_test', stub.stripe).verify('{}', 'sig');

    assert.deepEqual(event, {
      id: 'evt_test_1',
      type: 'checkout.session.completed',
      sessionId: 'cs_test_123',
      bookingId: '22',
      paymentStatus: 'paid',
      amountTotalCents: 4000,
    });
  });

  test('an event about something other than a session yields nulls, not a throw', async () => {
    const stub = stubVerifier({
      id: 'evt_test_2',
      type: 'customer.created',
      data: { object: { id: 'cus_1' } },
    });
    const event = new StripeWebhookVerifier('whsec_test', stub.stripe).verify('{}', 'sig');

    assert.equal(event.type, 'customer.created');
    assert.equal(event.bookingId, null);
    assert.equal(event.paymentStatus, null);
    assert.equal(event.amountTotalCents, null);
  });

  test('a rejected signature raises WebhookVerificationError, which the handler maps to 400', async () => {
    const stub = stubVerifier(completed, new Error('No signatures found matching the expected signature'));
    assert.throws(
      () => new StripeWebhookVerifier('whsec_test', stub.stripe).verify('{}', 'forged'),
      (err: unknown) => err instanceof WebhookVerificationError,
    );
  });
});
