/**
 * Lasting preferences the user states out loud ("I always shop at Target", "fast shipping matters most").
 * The remember_preference tool saves them through PreferenceStore. hello() loads them, and every later
 * search in that session and the next ones starts from them. One-off limits (this search's budget) are not saved here.
 */
import { PreferenceFact, Priority, type Marketplace, type Need } from "@visy/contracts";

export const PREF_KINDS = ["favorite_marketplace", "favorite_brand", "priority", "avoid"] as const;
export type PrefKind = (typeof PREF_KINDS)[number];

const STORES = ["amazon", "target", "walmart"] as const;
const PRIORITY_WORDS: Record<Priority, string> = {
  price: "a low price",
  quality: "quality",
  shipping_speed: "fast shipping",
  reviews: "good reviews",
  brand: "the brand",
  ease_of_use: "ease of use",
  sustainability: "sustainability",
};

const title = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A fact to save, or an error string for the model. The favorite store is one fact, so a new one replaces it. */
export function prefFact(kind: PrefKind, raw: string, evidence: string): PreferenceFact | string {
  let value = raw.trim();
  if (kind === "favorite_marketplace") {
    value = value.toLowerCase().replace(/\.com$/, "");
    if (!(STORES as readonly string[]).includes(value)) return "favorite_marketplace must be amazon, target or walmart.";
  }
  if (kind === "priority") {
    value = value.toLowerCase().replace(/[\s-]+/g, "_");
    if (!Priority.safeParse(value).success) return `priority must be one of ${Priority.options.join(", ")}.`;
  }
  if (!slug(value)) return "Give the preference value.";
  return PreferenceFact.parse({
    id: kind === "favorite_marketplace" ? "pref-favorite_marketplace" : `pref-${kind}-${slug(value)}`,
    kind,
    value,
    evidence: evidence.slice(0, 300),
    confidence: 0.9,
    updatedAt: new Date().toISOString(),
  });
}

/** The one line Visy says after saving. */
export function confirmLine(fact: PreferenceFact): string {
  if (fact.kind === "favorite_marketplace") return `Got it, I'll remember you prefer ${title(fact.value)}.`;
  if (fact.kind === "favorite_brand") return `Got it, I'll remember you like ${fact.value}.`;
  if (fact.kind === "priority") return `Got it, I'll remember ${PRIORITY_WORDS[fact.value as Priority] ?? fact.value} matters to you.`;
  return `Got it, I'll remember to avoid ${fact.value}.`;
}

const newest = (facts: PreferenceFact[], kind: PrefKind) =>
  facts.filter((f) => f.kind === kind).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/**
 * Only facts the user stated through remember_preference ("pref-" ids). The mock profile's favorite_marketplace
 * fixture is left out, so the default demo still searches all three stores.
 */
export function stated(facts: PreferenceFact[]): PreferenceFact[] {
  return facts.filter((f) => f.id.startsWith("pref-"));
}

/** Saved facts with this id replaced by the new one. */
export function withFact(facts: PreferenceFact[], fact: PreferenceFact): PreferenceFact[] {
  return [...facts.filter((f) => f.id !== fact.id), fact];
}

/** The favorite store, as the marketplaces to search when the user didn't name any this turn. */
export function favoriteStores(facts: PreferenceFact[]): Marketplace[] | undefined {
  const fav = newest(facts, "favorite_marketplace")[0];
  return fav ? [fav.value as Marketplace] : undefined;
}

/** Saved priorities, brands and avoids folded into a search's Need. The user's words this turn win. */
export function applySaved(need: Need, facts: PreferenceFact[]): Need {
  const priorities = newest(facts, "priority").map((f) => f.value as Priority);
  const brands = newest(facts, "favorite_brand").map((f) => `${f.value} brand`);
  const avoid = newest(facts, "avoid").map((f) => `not ${f.value}`);
  return {
    ...need,
    priorities: need.priorities.length ? need.priorities : priorities,
    niceToHaves: [...need.niceToHaves, ...brands.filter((b) => !need.niceToHaves.includes(b))],
    mustHaves: [...need.mustHaves, ...avoid.filter((a) => !need.mustHaves.includes(a))],
  };
}

/** Saved preferences for the per-turn message, so Claude doesn't ask again what the user already told it. */
export function savedBlock(facts: PreferenceFact[]): string {
  const lines = [
    ...newest(facts, "favorite_marketplace").slice(0, 1).map((f) => `favorite store: ${f.value}`),
    ...newest(facts, "favorite_brand").map((f) => `likes brand: ${f.value}`),
    ...newest(facts, "priority").map((f) => `cares about: ${f.value}`),
    ...newest(facts, "avoid").map((f) => `avoid: ${f.value}`),
  ];
  return lines.length ? `<saved_preferences>\n${lines.join("\n")}\n</saved_preferences>` : "";
}
