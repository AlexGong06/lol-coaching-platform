// A local HTTP server, so the handlers can be reached by curl and by `stripe listen`.
//
// NOT the production server. The design doc commits to Next.js App Router, and every
// handler in src/api is framework-free precisely so this can exist without prejudging
// that: each route below is four lines of plumbing around a function that is already
// tested. When the Next.js app arrives, this file is deleted and nothing in src/ moves.
//
// Dev-only, and it means it:
//   - binds to 127.0.0.1, never 0.0.0.0
//   - /api/dev/* has no authentication at all
//   - errors come back with their stack, which production must never do
//
//   npm run dev
//   stripe listen --events <the types the handler accepts> \
//     --forward-to localhost:3000/api/stripe/webhook
//
// The CLI refuses to listen without --events, --all-snapshot or --all-thin. The exact
// command, with the event list filled in, is printed on startup and in the webhook
// route's 503 body, both built from HANDLED_EVENT_TYPES so they cannot go stale.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import pg from 'pg';
import { handleAvailability } from '../src/api/availability.ts';
import { handleCheckout } from '../src/api/checkout.ts';
import { HANDLED_EVENT_TYPES, handleWebhook } from '../src/api/webhook.ts';
import { StripePaymentProvider } from '../src/stripe/provider.ts';
import { StripeWebhookVerifier } from '../src/stripe/verifier.ts';
import { DiscordInviteProvider } from '../src/discord/invites.ts';
import { sweepDueWork } from '../src/worker/sweep.ts';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = '127.0.0.1';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  console.error('DATABASE_URL is unset. `cp .env.example .env`, then `npm run db:up`.');
  process.exit(1);
}

// One connection, not a pool. createHold and the sweeper send BEGIN and COMMIT as plain
// statements, and a pool is free to route those to different backends. It also means
// requests queue behind each other, which is correct here and fine for one developer.
const db = new pg.Client({ connectionString: databaseUrl });

const stripeKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const provider =
  stripeKey === undefined
    ? null
    : new StripePaymentProvider({
        secretKey: stripeKey,
        successUrl: process.env.STRIPE_SUCCESS_URL ?? `http://localhost:${PORT}/booking/success`,
        cancelUrl: process.env.STRIPE_CANCEL_URL ?? `http://localhost:${PORT}/booking/cancelled`,
      });

const verifier = webhookSecret === undefined ? null : new StripeWebhookVerifier(webhookSecret);

const botToken = process.env.DISCORD_BOT_TOKEN;
const inviteChannelId = process.env.DISCORD_INVITE_CHANNEL_ID;

// Null unless BOTH are set. A sweep then leaves window rows queued with the reason in
// due_work.last_error, rather than claiming them and marking work done that never ran.
const invites =
  botToken === undefined || inviteChannelId === undefined
    ? null
    : new DiscordInviteProvider({ botToken, channelId: inviteChannelId });

/** The one command that produces a working signing secret, built from what we handle. */
const LISTEN_COMMAND =
  `stripe listen --events ${HANDLED_EVENT_TYPES.join(',')}` +
  ` --forward-to localhost:${PORT}/api/stripe/webhook`;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  // The raw text, kept raw. Stripe signs these exact bytes, so the webhook route must
  // never see a parsed-and-reserialized version of them.
  return Buffer.concat(chunks).toString('utf8');
}

const ROUTES = [
  'GET  /api/availability?sku=&from=&to=&tz=',
  'POST /api/checkout',
  'POST /api/stripe/webhook',
  'POST /api/dev/sweep          run one due-work pass now',
  'GET  /api/dev/bookings       the 20 most recent bookings and their state',
  'GET  /api/dev/invites        issued access codes (live credentials: dev only)',
];

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (path === '/' || path === '/api')) {
    send(res, 200, { server: 'lol-coaching dev', routes: ROUTES });
    return;
  }

  if (method === 'GET' && path === '/api/availability') {
    const query = Object.fromEntries(url.searchParams);
    const result = await handleAvailability(db, query, new Date());
    send(res, result.status, result.body);
    return;
  }

  if (method === 'POST' && path === '/api/checkout') {
    if (provider === null) {
      send(res, 503, { error: 'STRIPE_SECRET_KEY is unset, so no session can be created' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      send(res, 400, { error: 'body is not JSON' });
      return;
    }
    const result = await handleCheckout(db, provider, body, new Date());
    send(res, result.status, result.body);
    return;
  }

  if (method === 'POST' && path === '/api/stripe/webhook') {
    if (verifier === null) {
      // Loud rather than silent: an unverifiable webhook must never be treated as real.
      send(res, 503, {
        error: 'STRIPE_WEBHOOK_SECRET is unset',
        fix: `run: ${LISTEN_COMMAND}  (then put the printed whsec_... in .env and restart)`,
      });
      return;
    }
    const raw = await readBody(req);
    const signature = req.headers['stripe-signature'];
    const result = await handleWebhook(
      db,
      verifier,
      raw,
      typeof signature === 'string' ? signature : '',
      new Date(),
    );
    send(res, result.status, result.body);
    return;
  }

  if (method === 'POST' && path === '/api/dev/sweep') {
    const outcomes = await sweepDueWork(db, invites, new Date());
    send(res, 200, { ran: outcomes.length, outcomes });
    return;
  }

  if (method === 'GET' && path === '/api/dev/bookings') {
    const { rows } = await db.query(
      `SELECT b.id, b.state, b.sku, b.student_email, b.price_cents,
              r.starts_at, r.holds_slot, b.hold_expires_at, b.stripe_session_id,
              (SELECT count(*)::int FROM entitlements e WHERE e.booking_id = b.id)
                AS entitlements,
              (SELECT count(*)::int FROM due_work w
                WHERE w.booking_id = b.id AND w.done_at IS NULL) AS open_work
         FROM bookings b
         JOIN reservations r ON r.id = b.reservation_id
        ORDER BY b.id DESC
        LIMIT 20`,
    );
    send(res, 200, { bookings: rows });
    return;
  }

  if (method === 'GET' && path === '/api/dev/invites') {
    // The codes are not returned by the sweeper or printed in its log lines: a live
    // credential has no business in stdout on every pass. Until the student-facing
    // delivery exists, this endpoint is how a code is read back for a manual test.
    const { rows } = await db.query(
      `SELECT ai.code, ai.state, ai.max_age_seconds, ai.expires_at,
              e.booking_id, e.state AS entitlement_state, e.starts_at, e.ends_at
         FROM access_invites ai
         JOIN entitlements e ON e.id = ai.entitlement_id
        ORDER BY ai.id DESC
        LIMIT 20`,
    );
    send(res, 200, {
      invites: rows.map((row) => {
        const r = row as { code: string };
        return { ...r, url: `https://discord.gg/${r.code}` };
      }),
    });
    return;
  }

  send(res, 404, { error: `no route for ${method} ${path}`, routes: ROUTES });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${url.pathname} -> ${res.statusCode} (${Date.now() - started}ms)`);
  });

  route(req, res, url).catch((err: unknown) => {
    // Dev convenience: the stack goes to the client. A production handler returns a
    // request id and logs the rest.
    console.error(err);
    send(res, 500, {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
});

await db.connect();

server.listen(PORT, HOST, () => {
  console.log(`dev server on http://${HOST}:${PORT}`);
  for (const line of ROUTES) console.log(`  ${line}`);
  if (provider === null) console.log('  ! STRIPE_SECRET_KEY unset: /api/checkout returns 503');
  if (verifier === null) console.log('  ! STRIPE_WEBHOOK_SECRET unset: webhook returns 503');
  if (invites === null) {
    console.log('  ! DISCORD_BOT_TOKEN/DISCORD_INVITE_CHANNEL_ID unset: window work stays queued');
  }
  console.log(`\nto receive webhooks:\n  ${LISTEN_COMMAND}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal}: closing`);
    server.close(() => {
      void db.end().then(() => process.exit(0));
    });
  });
}
