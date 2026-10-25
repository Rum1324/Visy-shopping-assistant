import type { Need } from "@visy/contracts";

/**
 * C-PLANT: plant-search helpers for Nearly Natural (nearlynatural.com), a Shopify shop that only sells fake plants,
 * flowers and trees. The shop itself is searched by the generic Shopify adapter (shopify.ts, C-SHOPS).
 * Checked live on 2026-10-25 ("small green plant", "fern").
 */

/** Plant words that make a search worth sending to a fake-plant shop. */
const PLANT =
  /\b(house ?plants?|plants?|planters?|potted|succulents?|cact(?:us|i)|ferns?|fig|ficus|monstera|pothos|ivy|palms?|bonsai|orchids?|eucalyptus|olive tree|snake plant|sansevieria|zz plant|peperomia|boxwood|topiary|greenery|bamboo|aloe|philodendron|trees?|flowers?|bouquets?|wreaths?)\b/i;
const REAL = /\b(real|live|living)\s+(house ?)?plants?\b/i;

/** True when the shopper wants a plant (or flowers) and didn't ask for a living one. Fake ones are all this shop sells. */
export function isPlantSearch(need: Pick<Need, "query"> & Partial<Pick<Need, "mustHaves" | "niceToHaves">>) {
  const text = [need.query, ...(need.mustHaves ?? []), ...(need.niceToHaves ?? [])].join(" ");
  return PLANT.test(text) && !REAL.test(text);
}

/** "small fake green house plant" → "small green plant": everything here is fake, and Shopify ANDs the words. */
export function nearlyNaturalQuery(query: string) {
  return query
    .toLowerCase()
    .replace(/\b(fake|faux|artificial|silk|realistic|looking|indoor|for|a|an|the|some|i|want|need)\b/g, " ")
    .replace(/\bhouse ?plants?\b/g, "plant")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
