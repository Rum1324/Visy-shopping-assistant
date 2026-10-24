import { mutationGeneric as mutation, queryGeneric as query } from "convex/server";
import { v } from "convex/values";

export const list = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const facts = await ctx.db
      .query("facts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const purchases = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return { facts, purchases };
  },
});

export const upsertFact = mutation({
  args: {
    userId: v.string(),
    factId: v.string(),
    kind: v.string(),
    value: v.string(),
    detail: v.optional(v.string()),
    evidence: v.string(),
    confidence: v.number(),
    updatedAt: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("facts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const existing = rows.find((row) => row.factId === args.factId);
    if (existing) await ctx.db.patch(existing._id, args);
    else await ctx.db.insert("facts", args);
  },
});

export const recordPurchase = mutation({
  args: {
    userId: v.string(),
    productId: v.string(),
    title: v.string(),
    marketplace: v.string(),
    cents: v.number(),
    query: v.string(),
    purchasedAt: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const existing = rows.find((row) => row.productId === args.productId);
    if (existing) await ctx.db.patch(existing._id, args);
    else await ctx.db.insert("purchases", args);
  },
});
