import { z } from "zod";
import { IsoDate, Marketplace, Money, ProductId } from "./common.ts";

export const PreferenceFact = z.object({
  id: z.string(),
  kind: z.enum(["favorite_marketplace", "favorite_brand", "priority", "usual_item", "size", "avoid", "other"]),
  value: z.string(), // "Kirkland", "amazon", "shipping_speed"
  detail: z.string().optional(), // "for seaweed snacks"
  /** What the user actually said, for transparency ("You told me on Oct 20…"). */
  evidence: z.string(),
  confidence: z.number().min(0).max(1),
  updatedAt: IsoDate,
});
export type PreferenceFact = z.infer<typeof PreferenceFact>;

export const PurchaseRecord = z.object({
  productId: ProductId,
  title: z.string(),
  marketplace: Marketplace,
  price: Money,
  query: z.string(), // what the user originally asked for: "seaweed snacks"
  purchasedAt: IsoDate,
});
export type PurchaseRecord = z.infer<typeof PurchaseRecord>;

export const UserProfile = z.object({
  userId: z.string(),
  /** TTS speed multiplier. Many screen-reader users prefer 1.5x or faster (up to 3x). */
  speechRate: z.number().min(0.5).max(3).default(1),
  verbosity: z.enum(["brief", "normal", "detailed"]).default("normal"),
  facts: z.array(PreferenceFact).default([]),
  purchases: z.array(PurchaseRecord).default([]),
});
export type UserProfile = z.infer<typeof UserProfile>;
