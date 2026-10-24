/**
 * One-time demo seed. Writes through PreferenceStore, same as the app.
 * CONVEX_URL must be set. This file is the only place the stage purchase is named.
 */
import { convexPreferenceStore } from "./prefs-convex.ts";

const prefs = convexPreferenceStore();
const userId = "demo-user";
const when = "2026-10-01T17:00:00Z";
const productId = "amazon:B0SEAWEED1";
const title = "Roasted Seaweed Snacks, Sea Salt, 24 Pack";

const purchase = await prefs.recordPurchase(userId, {
  productId,
  title,
  marketplace: "amazon",
  price: { cents: 1599, currency: "USD" },
  query: "seaweed snacks",
  purchasedAt: when,
});
const fact = await prefs.upsertFact(userId, {
  id: `usual-${productId}`,
  kind: "usual_item",
  value: productId,
  detail: title,
  evidence: "Seeded past purchase. Visy did not place this order.",
  confidence: 0.95,
  updatedAt: when,
});
if (!purchase.ok || !fact.ok) {
  console.error(purchase.ok ? fact : purchase);
  process.exit(1);
}
console.log(`saved ${title} for ${userId}`);
