import { z } from "zod";
import { IsoDate, Marketplace, Money, ProductId } from "./common.ts";
import { ShortlistItem } from "./insights.ts";
import { Need } from "./need.ts";
import { ProductCandidate } from "./product.ts";

export const SessionPhase = z.enum([
  "idle",
  "clarifying",
  "searching",
  "shortlisting",
  "presenting",
  "qa",
  "carting",
  "checkout_review",
  "done",
]);
export type SessionPhase = z.infer<typeof SessionPhase>;

export const CartLine = z.object({
  productId: ProductId,
  title: z.string(),
  quantity: z.number().int().positive(),
  price: Money,
});
export type CartLine = z.infer<typeof CartLine>;

/** What we read back to the user on the vendor's final checkout page. The user places the order, never the agent. */
export const CheckoutReview = z.object({
  marketplace: Marketplace,
  url: z.url(),
  lines: z.array(CartLine),
  subtotal: Money,
  shipping: Money.optional(),
  tax: Money.optional(),
  total: Money,
  deliveryEstimate: z.string().optional(),
  shipTo: z.string().optional(), // e.g. "Home, ending ...Berkeley". No full address on the wire.
  readBack: z.string(), // the exact sentence spoken to the user
});
export type CheckoutReview = z.infer<typeof CheckoutReview>;

/** Owned and mutated ONLY by the server's conversation agent. Everyone else reads snapshots. */
export const SessionState = z.object({
  sessionId: z.string(),
  userId: z.string(),
  phase: SessionPhase,
  need: Need.optional(),
  candidates: z.array(ProductCandidate).default([]),
  shortlist: z.array(ShortlistItem).max(3).default([]),
  focusedProductId: ProductId.optional(),
  cart: z.array(CartLine).default([]),
  checkout: CheckoutReview.optional(),
  updatedAt: IsoDate,
});
export type SessionState = z.infer<typeof SessionState>;
