import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** Preference rows. The agent talks to PreferenceStore; these are the stored fields. */
export default defineSchema({
  facts: defineTable({
    userId: v.string(),
    factId: v.string(),
    kind: v.string(),
    value: v.string(),
    detail: v.optional(v.string()),
    evidence: v.string(),
    confidence: v.number(),
    updatedAt: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_user_fact", ["userId", "factId"]),
  purchases: defineTable({
    userId: v.string(),
    productId: v.string(),
    title: v.string(),
    marketplace: v.string(),
    cents: v.number(),
    query: v.string(),
    purchasedAt: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_user_product", ["userId", "productId"]),
});
