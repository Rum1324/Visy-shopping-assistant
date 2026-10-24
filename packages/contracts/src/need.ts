import { z } from "zod";
import { Marketplace, Money } from "./common.ts";

export const Priority = z.enum(["price", "quality", "shipping_speed", "reviews", "brand", "ease_of_use", "sustainability"]);
export type Priority = z.infer<typeof Priority>;

/** What the user wants, structured by the conversation agent during `clarifying`. */
export const Need = z.object({
  /** Search keywords for marketplaces, e.g. "waterproof picnic blanket". */
  query: z.string().min(1),
  category: z.string().optional(),
  budget: z.object({ min: Money.optional(), max: Money.optional() }).optional(),
  /** Free-form attributes like { size: "large", color: "blue" }. */
  attributes: z.record(z.string(), z.string()).default({}),
  mustHaves: z.array(z.string()).default([]),
  niceToHaves: z.array(z.string()).default([]),
  /** Ordered: most important first. */
  priorities: z.array(Priority).default([]),
  marketplaces: z.array(Marketplace).min(1),
  /** E.g. "tactile buttons", "easy-open packaging". Fed into review synthesis. */
  accessibilityNotes: z.array(z.string()).default([]),
  quantity: z.number().int().positive().default(1),
});
export type Need = z.infer<typeof Need>;
