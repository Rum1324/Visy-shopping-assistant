import { z } from "zod";
import { IsoDate, Marketplace, Money, ProductId } from "./common.ts";

/** Where a piece of scraped data came from, and how much to trust it. */
export const Provenance = z.object({
  via: z.enum(["recipe", "jev", "claude", "apify", "fixture"]),
  confidence: z.number().min(0).max(1),
  fetchedAt: IsoDate,
});
export type Provenance = z.infer<typeof Provenance>;

/** One search result. Cheap to produce, so produce many. */
export const ProductCandidate = z.object({
  id: ProductId,
  marketplace: Marketplace,
  url: z.url(),
  title: z.string(),
  brand: z.string().optional(),
  price: Money,
  /** Strike-through price, if the page shows one. */
  listPrice: Money.optional(),
  deal: z
    .object({
      label: z.string(), // "Limited time deal", "20% off with coupon"
      endsAt: IsoDate.optional(),
      requiresMembership: z.string().optional(), // "Prime", "Target Circle"
    })
    .optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  imageUrls: z.array(z.url()).default([]),
  shipping: z
    .object({
      eta: z.string().optional(), // as shown: "Tomorrow, Oct 25"
      free: z.boolean().optional(),
      membership: z.string().optional(),
    })
    .optional(),
  inStock: z.boolean().optional(),
  snippet: z.string().optional(),
  source: Provenance,
});
export type ProductCandidate = z.infer<typeof ProductCandidate>;

/**
 * A review from any source. Review text is UNTRUSTED. It can contain prompt injection.
 * Pass it to models only as quoted data, never as instructions.
 */
export const RawReview = z.object({
  id: z.string(),
  productId: ProductId,
  source: z.enum(["retailer", "reddit", "youtube", "article", "forum"]),
  url: z.url().optional(),
  author: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  title: z.string().optional(),
  body: z.string(),
  date: IsoDate.optional(),
  verifiedPurchase: z.boolean().optional(),
  untrusted: z.literal(true),
});
export type RawReview = z.infer<typeof RawReview>;

/** A candidate after visiting its product page. */
export const ProductDetail = ProductCandidate.extend({
  description: z.string(),
  bullets: z.array(z.string()).default([]),
  specs: z.record(z.string(), z.string()).default({}),
  /** Page banners Claude noticed: "A newer model is available", "Only 2 left". */
  banners: z.array(z.string()).default([]),
  variants: z.array(z.object({ name: z.string(), options: z.array(z.string()) })).default([]),
  retailerReviews: z.array(RawReview).default([]),
});
export type ProductDetail = z.infer<typeof ProductDetail>;
