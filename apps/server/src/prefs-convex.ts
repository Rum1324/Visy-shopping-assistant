/**
 * Convex client for PreferenceStore. Deploy with `npx convex dev` from apps/server.
 * CONVEX_URL is the deployment URL. It stays in apps/server/.env.
 */
import { anyApi } from "convex/server";
import { ConvexHttpClient } from "convex/browser";
import { PreferenceFact, PurchaseRecord } from "@visy/contracts";
import { preferenceStore, type PrefsDb } from "./prefs.ts";

type FactRow = {
  factId: string;
  kind: string;
  value: string;
  detail?: string;
  evidence: string;
  confidence: number;
  updatedAt: string;
};

type PurchaseRow = {
  productId: string;
  title: string;
  marketplace: string;
  cents: number;
  query: string;
  purchasedAt: string;
};

export function convexPrefsDb(url: string): PrefsDb {
  const client = new ConvexHttpClient(url);
  return {
    async list(userId) {
      const rows = (await client.query(anyApi.prefs.list, { userId })) as {
        facts: FactRow[];
        purchases: PurchaseRow[];
      };
      return {
        facts: (rows?.facts ?? []).map((row) =>
          PreferenceFact.parse({
            id: row.factId,
            kind: row.kind,
            value: row.value,
            detail: row.detail,
            evidence: row.evidence,
            confidence: row.confidence,
            updatedAt: row.updatedAt,
          }),
        ),
        purchases: (rows?.purchases ?? []).map((row) =>
          PurchaseRecord.parse({
            productId: row.productId,
            title: row.title,
            marketplace: row.marketplace,
            price: { cents: row.cents, currency: "USD" },
            query: row.query,
            purchasedAt: row.purchasedAt,
          }),
        ),
      };
    },
    async upsertFact(userId, fact) {
      await client.mutation(anyApi.prefs.upsertFact, {
        userId,
        factId: fact.id,
        kind: fact.kind,
        value: fact.value,
        detail: fact.detail,
        evidence: fact.evidence,
        confidence: fact.confidence,
        updatedAt: fact.updatedAt,
      });
    },
    async recordPurchase(userId, purchase) {
      await client.mutation(anyApi.prefs.recordPurchase, {
        userId,
        productId: purchase.productId,
        title: purchase.title,
        marketplace: purchase.marketplace,
        cents: purchase.price.cents,
        query: purchase.query,
        purchasedAt: purchase.purchasedAt,
      });
    },
  };
}

export function convexPreferenceStore(url = process.env.CONVEX_URL?.trim() ?? "") {
  if (!url) throw new Error("PREFS=convex requires CONVEX_URL in apps/server/.env");
  return preferenceStore(convexPrefsDb(url));
}
