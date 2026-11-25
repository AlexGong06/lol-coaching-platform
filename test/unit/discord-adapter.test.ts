// The Discord adapter against a fake fetch.
//
// Two things are worth asserting here and nowhere else. First the request body, because
// `unique: true` and `max_uses: 1` are the difference between one student getting one
// code and two students sharing one, and neither is visible in any later test. Second
// the refusals, because 401/403/404 are exactly the setup mistakes a first run makes
// and a bare status code sends you to the wrong setting.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordInviteProvider, DISCORD_API_BASE } from '../../src/discord/invites.ts';
import { InviteProviderError } from '../../src/access.ts';

const CONFIG = { botToken: 'bot-token-xyz', channelId: '1462660000000000000' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers with `responses` in order and records what it was asked. */
function recordingFetch(responses: Response[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const response = responses[i];
    i += 1;
    if (response === undefined) throw new Error('fake fetch ran out of responses');
    return response;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const inviteJson = (over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ code: 'aBcD1234', ...over }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const failure = (status: number, statusText: string, body = '') =>
  new Response(body, { status, statusText });

describe('creating an invite', () => {
  test('posts to the channel the config names', async () => {
    const { fetch, calls } = recordingFetch([inviteJson()]);
    await new DiscordInviteProvider(CONFIG, fetch).createInvite({
      maxAgeSeconds: 3600, reason: 'booking 209',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.url, `${DISCORD_API_BASE}/channels/${CONFIG.channelId}/invites`);
  });

  test('authenticates as a bot, not a bearer token', async () => {
    const { fetch, calls } = recordingFetch([inviteJson()]);
    await new DiscordInviteProvider(CONFIG, fetch).createInvite({
      maxAgeSeconds: 60, reason: 'r',
    });
    assert.equal(calls[0]?.headers['authorization'], 'Bot bot-token-xyz');
  });

  test('asks for a single-use, unique, non-temporary invite', async () => {
    const { fetch, calls } = recordingFetch([inviteJson()]);
    await new DiscordInviteProvider(CONFIG, fetch).createInvite({
      maxAgeSeconds: 3600, reason: 'r',
    });
    assert.deepEqual(calls[0]?.body, {
      max_age: 3600,
      max_uses: 1,
      // Without unique, Discord may hand back an EXISTING matching invite and two
      // bookings would share one code.
      unique: true,
      // True would eject a student whose voice connection dropped mid-session.
      temporary: false,
    });
  });

  test('sends the reason url-encoded, so Discord accepts it', async () => {
    const { fetch, calls } = recordingFetch([inviteJson()]);
    await new DiscordInviteProvider(CONFIG, fetch).createInvite({
      maxAgeSeconds: 60, reason: 'coaching booking 209',
    });
    assert.equal(calls[0]?.headers['x-audit-log-reason'], 'coaching%20booking%20209');
  });

  test('returns the code and a joinable url', async () => {
    const { fetch } = recordingFetch([inviteJson({ code: 'zZ9yY8' })]);
    const invite = await new DiscordInviteProvider(CONFIG, fetch).createInvite({
      maxAgeSeconds: 60, reason: 'r',
    });
    assert.equal(invite.code, 'zZ9yY8');
    assert.equal(invite.url, 'https://discord.gg/zZ9yY8');
  });

  test("prefers Discord's own expiry over the one we asked for", async () => {
    // The whole point: max_age counts down from THEIR creation time, so their value is
    // the only one that says when the code really dies.
    const { fetch } = recordingFetch([inviteJson({ expires_at: '2026-11-28T01:00:05.000Z' })]);
    const invite = await new DiscordInviteProvider(CONFIG, fetch).createInvite({
      maxAgeSeconds: 3600, reason: 'r',
    });
    assert.equal(invite.expiresAt.toISOString(), '2026-11-28T01:00:05.000Z');
  });

  test('falls back to a computed expiry when the response omits one', async () => {
    const { fetch } = recordingFetch([inviteJson()]);
    const before = Date.now();
    const invite = await new DiscordInviteProvider(CONFIG, fetch).createInvite({
      maxAgeSeconds: 3600, reason: 'r',
    });
    const expected = before + 3_600_000;
    assert.ok(Math.abs(invite.expiresAt.getTime() - expected) < 5_000);
  });

  test('a response with no code is a failure, not an invite', async () => {
    const { fetch } = recordingFetch([new Response('{}', { status: 200 })]);
    await assert.rejects(
      new DiscordInviteProvider(CONFIG, fetch).createInvite({ maxAgeSeconds: 60, reason: 'r' }),
      (err: unknown) => err instanceof InviteProviderError && /no code/.test((err as Error).message),
    );
  });

  test('a non-JSON body is a failure', async () => {
    const { fetch } = recordingFetch([new Response('<html>503</html>', { status: 200 })]);
    await assert.rejects(
      new DiscordInviteProvider(CONFIG, fetch).createInvite({ maxAgeSeconds: 60, reason: 'r' }),
      InviteProviderError,
    );
  });

  test('a network failure is wrapped, keeping the original as cause', async () => {
    const boom = new Error('ECONNRESET');
    const impl = (async () => { throw boom; }) as typeof fetch;
    await assert.rejects(
      new DiscordInviteProvider(CONFIG, impl).createInvite({ maxAgeSeconds: 60, reason: 'r' }),
      (err: unknown) => err instanceof InviteProviderError && err.cause === boom,
    );
  });
});

describe('refusals name the setting at fault', () => {
  const cases: [number, string, RegExp][] = [
    [401, 'Unauthorized', /DISCORD_BOT_TOKEN/],
    // The one that wastes an afternoon: the role grants it, a channel override denies it.
    [403, 'Forbidden', /Create Instant Invite.*channel-level/s],
    [404, 'Not Found', /DISCORD_INVITE_CHANNEL_ID/],
    [429, 'Too Many Requests', /rate limited/],
  ];

  for (const [status, statusText, pattern] of cases) {
    test(`${status} explains what to change`, async () => {
      const { fetch } = recordingFetch([failure(status, statusText)]);
      await assert.rejects(
        new DiscordInviteProvider(CONFIG, fetch).createInvite({ maxAgeSeconds: 60, reason: 'r' }),
        (err: unknown) => {
          assert.ok(err instanceof InviteProviderError);
          assert.match(err.message, pattern);
          assert.match(err.message, new RegExp(String(status)));
          return true;
        },
      );
    });
  }

  test("Discord's own error text is included, truncated", async () => {
    const { fetch } = recordingFetch([
      failure(400, 'Bad Request', JSON.stringify({ message: 'Invalid Form Body', code: 50035 })),
    ]);
    await assert.rejects(
      new DiscordInviteProvider(CONFIG, fetch).createInvite({ maxAgeSeconds: 60, reason: 'r' }),
      /Invalid Form Body/,
    );
  });
});

describe('deleting an invite', () => {
  test('a 404 is unknown, not gone: Discord says it for a code it will not let us delete',
    async () => {
      // Verified against the real API: deleting needs Manage Channels, which this bot is
      // not given, and Discord reports that as 404 "Unknown Invite" rather than 403. A
      // code created one second earlier deletes as 404. Reading that as a confirmed
      // removal would record cleanup that never happened.
      const { fetch } = recordingFetch([failure(404, 'Not Found')]);
      const outcome = await new DiscordInviteProvider(CONFIG, fetch).deleteInvite('aBcD1234');
      assert.equal(outcome, 'unknown');
    });

  test('a 200 means this worker removed a code that was still live', async () => {
    const { fetch, calls } = recordingFetch([inviteJson()]);
    const outcome = await new DiscordInviteProvider(CONFIG, fetch).deleteInvite('aBcD1234');
    assert.equal(outcome, 'deleted');
    assert.equal(calls[0]?.method, 'DELETE');
    assert.equal(calls[0]?.url, `${DISCORD_API_BASE}/invites/aBcD1234`);
  });

  test('any other status throws, so the work row stays queued', async () => {
    const { fetch } = recordingFetch([failure(500, 'Internal Server Error')]);
    await assert.rejects(
      new DiscordInviteProvider(CONFIG, fetch).deleteInvite('aBcD1234'),
      InviteProviderError,
    );
  });
});
