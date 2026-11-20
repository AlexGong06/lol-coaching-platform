// The SKU table, in one place, because three things have to agree about it: the
// duration availability search looks for, the amount Stripe charges, and the label the
// student reads. The design doc fixes all three.

export const SKUS = {
  vod_review:    { label: 'VOD Review',    durationMinutes: 60,  priceCents: 3000, expectsUpload: true },
  live_coaching: { label: 'Live Coaching', durationMinutes: 60,  priceCents: 4000, expectsUpload: false },
  both:          { label: 'Both',          durationMinutes: 120, priceCents: 6000, expectsUpload: true },
} as const;

export type Sku = keyof typeof SKUS;

export const SKU_NAMES = Object.keys(SKUS) as Sku[];

export function isSku(value: unknown): value is Sku {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SKUS, value);
}

export function durationMinutes(sku: Sku): number {
  return SKUS[sku].durationMinutes;
}
