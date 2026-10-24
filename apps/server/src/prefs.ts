/**
 * PreferenceStore over a small database client.
 * Convex is the live client. Tests pass a memory client. Moss recall is later.
 */
import {
  err,
  ok,
  PreferenceFact,
  PurchaseRecord,
  UserProfile,
  type PreferenceFact as Fact,
  type PreferenceStore,
  type PurchaseRecord as Purchase,
} from "@visy/contracts";

export interface PrefsDb {
  list(userId: string): Promise<{ facts: Fact[]; purchases: Purchase[] }>;
  upsertFact(userId: string, fact: Fact): Promise<void>;
  recordPurchase(userId: string, purchase: Purchase): Promise<void>;
}

export function memoryPrefsDb(): PrefsDb {
  const facts = new Map<string, Fact[]>();
  const purchases = new Map<string, Purchase[]>();
  return {
    async list(userId) {
      return { facts: facts.get(userId) ?? [], purchases: purchases.get(userId) ?? [] };
    },
    async upsertFact(userId, fact) {
      const rows = facts.get(userId) ?? [];
      facts.set(userId, [...rows.filter((row) => row.id !== fact.id), fact]);
    },
    async recordPurchase(userId, purchase) {
      const rows = purchases.get(userId) ?? [];
      purchases.set(userId, [...rows.filter((row) => row.productId !== purchase.productId), purchase]);
    },
  };
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
}

function mentions(query: string, text: string): boolean {
  return words(query).some((word) => text.toLowerCase().includes(word));
}

export function preferenceStore(db: PrefsDb): PreferenceStore {
  return {
    async getProfile(userId) {
      try {
        const rows = await db.list(userId);
        return ok(UserProfile.parse({ userId, facts: rows.facts, purchases: rows.purchases }));
      } catch (error) {
        return err("internal", error instanceof Error ? error.message : "profile read failed");
      }
    },
    async upsertFact(userId, fact) {
      try {
        const parsed = PreferenceFact.parse(fact);
        await db.upsertFact(userId, parsed);
        return ok(parsed);
      } catch (error) {
        return err("internal", error instanceof Error ? error.message : "fact write failed");
      }
    },
    async recordPurchase(userId, purchase) {
      try {
        const parsed = PurchaseRecord.parse(purchase);
        await db.recordPurchase(userId, parsed);
        return ok(parsed);
      } catch (error) {
        return err("internal", error instanceof Error ? error.message : "purchase write failed");
      }
    },
    async recall(userId, query, k = 5) {
      try {
        const rows = await db.list(userId);
        return ok(select(query, rows.facts, rows.purchases, k));
      } catch (error) {
        return err("internal", error instanceof Error ? error.message : "recall failed");
      }
    },
  };
}

function select(query: string, facts: Fact[], purchases: Purchase[], k: number) {
  const pickedFacts = facts.filter((fact) => mentions(query, `${fact.value} ${fact.detail ?? ""} ${fact.evidence}`));
  const pickedPurchases = purchases.filter((purchase) => mentions(query, `${purchase.title} ${purchase.query}`));
  if (!/\busual\b/i.test(query)) {
    return { facts: pickedFacts.slice(0, k), purchases: pickedPurchases.slice(0, k) };
  }
  const usual = facts.filter((fact) => fact.kind === "usual_item");
  const ids = new Set(usual.map((fact) => fact.value));
  const linked = purchases.filter((purchase) => ids.has(purchase.productId));
  return {
    facts: unique([...usual, ...pickedFacts], (fact) => fact.id).slice(0, k),
    purchases: unique([...linked, ...pickedPurchases], (purchase) => purchase.productId).slice(0, k),
  };
}

function unique<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = key(row);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
