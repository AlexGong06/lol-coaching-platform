// The Discord side of the invite boundary: one implementation of InviteProvider.
//
// This is the only file in src/ that knows Discord's HTTP API exists. There is no SDK:
// two REST calls do not justify a dependency that would also pull in a gateway client
// this system has no use for. The bot never connects to the gateway and is never
// "online"; it holds a token and makes two calls.
//
// Every refusal here is a setup mistake with a specific fix, so the messages name it.
// A 403 on a channel the bot can see means a channel-level permission override is
// denying Create Instant Invite, which is invisible in the role settings people check.

import {
  type CreateInviteInput, type DeleteOutcome, type InviteProvider, type IssuedInvite,
  InviteProviderError,
} from '../access.ts';

export const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * Bounded because this call happens with the due_work row and the booking row locked.
 * An unbounded fetch would hold both for as long as Discord felt like taking.
 */
export const REQUEST_TIMEOUT_MS = 5_000;

export interface DiscordInviteConfig {
  /** A bot token. Full authority for the bot, so the bot is given one permission. */
  botToken: string;
  /** Invites are per-channel in Discord's API, not per-server. */
  channelId: string;
}

interface InviteResponse {
  code?: unknown;
  expires_at?: unknown;
}

export class DiscordInviteProvider implements InviteProvider {
  private readonly config: DiscordInviteConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: DiscordInviteConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  private headers(reason?: string): Record<string, string> {
    return {
      authorization: `Bot ${this.config.botToken}`,
      'content-type': 'application/json',
      // Discord decodes this header, and rejects raw non-ASCII in it.
      ...(reason === undefined ? {} : { 'x-audit-log-reason': encodeURIComponent(reason) }),
    };
  }

  async createInvite(input: CreateInviteInput): Promise<IssuedInvite> {
    const url = `${DISCORD_API_BASE}/channels/${this.config.channelId}/invites`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(input.reason),
        body: JSON.stringify({
          max_age: input.maxAgeSeconds,
          // One student per code. Discord deletes the invite on first use, which is
          // also why a disappeared code is never reissued: a reissue would admit a
          // second stranger every poll interval.
          max_uses: 1,
          // Without this Discord is free to return an EXISTING invite with matching
          // settings instead of creating one. Two bookings an hour apart would then
          // share a code, and the second student's access would end with the first's.
          unique: true,
          // Temporary membership kicks a member the moment they disconnect from voice.
          // On a coaching session that ejects a student whose connection drops.
          temporary: false,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new InviteProviderError('Discord could not be reached to create an invite', err);
    }

    if (!response.ok) throw await describeFailure(response, 'create an invite');

    let body: InviteResponse;
    try {
      body = (await response.json()) as InviteResponse;
    } catch (err) {
      throw new InviteProviderError('Discord returned a non-JSON invite', err);
    }

    if (typeof body.code !== 'string' || body.code === '') {
      throw new InviteProviderError('Discord returned an invite with no code');
    }

    return {
      code: body.code,
      url: `https://discord.gg/${body.code}`,
      // Discord's own expiry when it reports one. The computed fallback is only for a
      // response shape that omits it; it assumes zero clock skew, which is the thing
      // the reported value exists to correct.
      expiresAt:
        typeof body.expires_at === 'string'
          ? new Date(body.expires_at)
          : new Date(Date.now() + input.maxAgeSeconds * 1_000),
    };
  }

  async deleteInvite(code: string): Promise<DeleteOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${DISCORD_API_BASE}/invites/${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: this.headers('coaching window closed'),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new InviteProviderError(`Discord could not be reached to delete ${code}`, err);
    }

    // Not a confirmed removal: see DeleteOutcome. Not an error either, because it is
    // the expected answer for a bot holding only Create Instant Invite.
    if (response.status === 404) return 'unknown';
    if (!response.ok) throw await describeFailure(response, `delete invite ${code}`);
    return 'deleted';
  }
}

/** Turn a refusal into a message that names the setting at fault. */
async function describeFailure(response: Response, action: string): Promise<InviteProviderError> {
  const detail = await response.text().catch(() => '');
  const fix = HINTS[response.status];
  return new InviteProviderError(
    `Discord refused to ${action}: ${response.status} ${response.statusText}` +
      `${fix === undefined ? '' : ` (${fix})`}${detail === '' ? '' : ` ${detail.slice(0, 300)}`}`,
  );
}

const HINTS: Record<number, string> = {
  401: 'DISCORD_BOT_TOKEN is wrong or was reset in the developer portal',
  403: 'the bot lacks Create Instant Invite on this channel, often a channel-level ' +
    'permission override rather than the role',
  404: 'DISCORD_INVITE_CHANNEL_ID does not name a channel this bot can see',
  // Deleting an invite needs Manage Channels, which this bot is not given. Discord
  // reports that as 404, handled above, so this line is for the create path only.
  429: 'rate limited; the work row stays queued and the next pass retries it',
};
