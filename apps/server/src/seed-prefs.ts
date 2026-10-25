/**
 * One-time demo seed. Writes through PreferenceStore, same as the app.
 * CONVEX_URL must be set. This file is the only place the stage purchases are named.
 * Rows upsert by product, so running it again is safe.
 */
import { convexPreferenceStore } from "./prefs-convex.ts";

const prefs = convexPreferenceStore();
const userId = "demo-user";

const items = [
  // HANDOFF demo script: "the usual seaweed". Not a real ASIN, so it can be recalled but not carted.
  { productId: "amazon:B0SEAWEED1", title: "Roasted Seaweed Snacks, Sea Salt, 24 Pack", cents: 1599, query: "seaweed snacks", when: "2026-10-01T17:00:00Z" },
  // Video cold open: "I'm out of sugar, get the usual". Real listing, shipped by Amazon ($7.83 on 2026-10-25).
  { productId: "amazon:B01JA9KAOM", title: "Domino Sugar Granulated Canister, 1 lb", cents: 783, query: "sugar", when: "2026-10-11T17:00:00Z" },
];

for (const item of items) {
  const purchase = await prefs.recordPurchase(userId, {
    productId: item.productId,
    title: item.title,
    marketplace: "amazon",
    price: { cents: item.cents, currency: "USD" },
    query: item.query,
    purchasedAt: item.when,
  });
  const fact = await prefs.upsertFact(userId, {
    id: `usual-${item.productId}`,
    kind: "usual_item",
    value: item.productId,
    detail: item.title,
    evidence: "Seeded past purchase. Visy did not place this order.",
    confidence: 0.95,
    updatedAt: item.when,
  });
  if (!purchase.ok || !fact.ok) {
    console.error(purchase.ok ? fact : purchase);
    process.exit(1);
  }
  console.log(`saved ${item.title} for ${userId}`);
}
