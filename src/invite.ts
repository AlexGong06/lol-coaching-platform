// How long an invite may live, as a pure function.
//
// Discord's `max_age` counts down from creation, so an invite cannot be minted in
// advance to become valid later. It must be created when the window opens.
//
// `max_age: 0` means NEVER EXPIRES. A poller running late past `ends_at` would compute
// a non-positive value, and an unguarded call would mint a permanent credential for a
// session that is already over. So the guard is not tidiness.
//
// There is no round-up. An earlier draft clamped sub-minute values to 60 seconds to
// avoid racing a reissue, which let a code outlive its own window by up to 50 seconds
// and broke the invariant the crash-orphan argument depends on. With one code per
// booking and no reissue there is no race to avoid, so the invariant holds absolutely:
// every issued code expires at or before ends_at.

export type InviteDecision =
  | { create: false; reason: 'window_over' }
  | { create: true; maxAgeSeconds: number };

export const DISCORD_MAX_AGE_CEILING_SECONDS = 604_800; // 7 days, Discord's limit

export function decideInviteMaxAge(endsAt: Date, now: Date): InviteDecision {
  const remainingMs = endsAt.getTime() - now.getTime();
  // Whole seconds, floored: never round up past ends_at.
  const seconds = Math.floor(remainingMs / 1000);

  if (seconds <= 0) return { create: false, reason: 'window_over' };

  return { create: true, maxAgeSeconds: Math.min(seconds, DISCORD_MAX_AGE_CEILING_SECONDS) };
}
