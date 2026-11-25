// The invite provider boundary.
//
// The same split as payments.ts, for the same reason: Discord is not imported here or
// anywhere on the worker path. The window handlers take an InviteProvider, so the
// decision of when to mint a code, what to record and how to resolve a window is
// testable with no bot token, no server and no network.
//
// It buys one thing Discord cannot be asked for: a provider that fails *after* minting.
// That is the failure that leaves a live credential with no row pointing at it, and it
// is the one worth having a test for.

/** What the provider gives back for a successfully created invite. */
export interface IssuedInvite {
  /** Discord's invite code, the path component of the URL. UNIQUE in access_invites. */
  code: string;
  /** The full joinable URL, which is what the student is actually handed. */
  url: string;
  /**
   * When the code stops working.
   *
   * Discord's own value when it reports one, not the value we asked for. `max_age`
   * counts down from the instant DISCORD created the invite, so if our clock runs
   * behind theirs the code outlives the window by the difference. Reading their
   * expiry back is how that skew becomes visible instead of assumed away.
   */
  expiresAt: Date;
}

export interface CreateInviteInput {
  /** Always positive: see decideInviteMaxAge. `max_age: 0` means NEVER EXPIRES. */
  maxAgeSeconds: number;
  /** Written to Discord's audit log, so the server owner can see why a code appeared. */
  reason: string;
}

/**
 * What Discord said when asked to remove a code.
 *
 * `unknown` is the honest name for a 404. Discord answers "Unknown Invite" both for a
 * code that is really gone AND for a live code the bot is not allowed to delete, and
 * deleting requires Manage Channels, which this bot is deliberately not given. Verified
 * against the real API: a code created one second earlier deletes as 404. Calling that
 * `gone` would record a removal that never happened, so it does not.
 *
 * Only `deleted` is a confirmed removal.
 */
export type DeleteOutcome = 'deleted' | 'unknown';

export interface InviteProvider {
  createInvite(input: CreateInviteInput): Promise<IssuedInvite>;
  deleteInvite(code: string): Promise<DeleteOutcome>;
}

/**
 * Thrown by an adapter when Discord could not be reached or refused the request.
 *
 * The window handler lets this roll its own due_work row back, leaving `done_at` NULL so
 * the next pass retries. No retry happens inside the handler: it runs with the work row
 * and the booking row locked, and a second network round trip would hold both for the
 * length of another timeout.
 */
export class InviteProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'InviteProviderError';
  }
}
