import { z } from "zod";

/** Bump when a breaking change is unavoidable. Additive (optional) fields do not bump it. */
export const CONTRACT_VERSION = 1;

export const Marketplace = z.enum(["amazon", "target", "walmart", "bestbuy", "ebay", "other", "nearlynatural", "shopify"]);
/** "shopify" ids are `shopify:<shop domain>:<product id>`; the shop name comes from the domain (C-SHOPS). */
export type Marketplace = z.infer<typeof Marketplace>;

/** Money is always integer cents. Never floats. */
export const Money = z.object({
  cents: z.number().int().nonnegative(),
  currency: z.literal("USD"),
});
export type Money = z.infer<typeof Money>;

/** ISO-8601 UTC string, e.g. "2026-10-24T18:00:00Z". */
export const IsoDate = z.iso.datetime();
export type IsoDate = z.infer<typeof IsoDate>;

/** `${marketplace}:${nativeId}`, e.g. "amazon:B0EXAMPLE1". Stable for a product across the whole session. */
export const ProductId = z.string().regex(/^[a-z]+:\S+$/);
export type ProductId = z.infer<typeof ProductId>;

export const productId = (marketplace: Marketplace, nativeId: string): ProductId => `${marketplace}:${nativeId}`;

export const ErrorCode = z.enum([
  "timeout",
  "blocked", // CAPTCHA / bot wall
  "login_required",
  "not_found",
  "parse_failed",
  "low_confidence", // Jev and Claude fallback both unsure
  "forbidden_action", // e.g. tried to click a final purchase button
  "rate_limited",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const AppError = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
});
export type AppError = z.infer<typeof AppError>;

/** Every cross-module async call returns a Result. Throwing across a module boundary is not allowed. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const err = <T = never>(code: ErrorCode, message: string, retryable = false): Result<T> => ({
  ok: false,
  error: { code, message, retryable },
});

/** Short, speakable status for slow work. The voice layer decides whether and when to say it. */
export const ProgressEvent = z.object({
  stage: z.enum(["clarifying", "searching", "reading_product", "reviews", "vision", "shortlisting", "carting", "checkout"]),
  marketplace: Marketplace.optional(),
  message: z.string(), // "Searching Amazon now"
  fraction: z.number().min(0).max(1).optional(),
  at: IsoDate,
});
export type ProgressEvent = z.infer<typeof ProgressEvent>;

/** Passed into every slow service call so it can report progress without knowing about voice or the UI. */
export type Emit = (event: ProgressEvent) => void;

/** Time budgets (ms). On timeout, return err("timeout", …, true) and keep any partial data. */
export const BUDGETS_MS = {
  jevDecision: 800,
  claudeFallbackDecision: 6_000,
  marketplaceSearch: 10_000,
  productDetail: 8_000,
  externalReviews: 12_000,
  reviewSynthesis: 6_000,
  vision: 5_000,
  driverOp: 5_000,
} as const;
