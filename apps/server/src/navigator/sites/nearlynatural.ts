import { err, ok, productId, ProductCandidate, ProductDetail, type Emit, type Need, type Result } from "@visy/contracts";
import type { PriceRange } from "./search-urls.ts";

/**
 * C-PLANT: Nearly Natural (nearlynatural.com), a Shopify shop that only sells fake plants, flowers and trees.
 * Search only, no cart. Shopify's predictive search (/search/suggest.json) returns up to 10 products with price,
 * images and the full description, so one plain fetch per search covers search AND detail. Product pages and
 * /products/<handle>.js get rate limited (429) after a few non-browser requests, so we never call them.
 * Checked live on 2026-10-25 ("small green plant", "fern"). Everything read here is page data: UNTRUSTED.
 */

const BASE = "https://nearlynatural.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

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

type Row = {
  id: number;
  title: string;
  handle: string;
  body: string;
  price: string;
  compare_at_price_max?: string;
  available: boolean;
  vendor?: string;
  type?: string;
  tags?: string[];
  image?: string;
  featured_image?: { url?: string };
};

const usd = (cents: number) => ({ cents, currency: "USD" as const });
const toCents = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
};
const strip = (s: string) =>
  s
    .replace(/<\/(p|li|h\d)>/gi, ". ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/\s+/g, " ")
    .replace(/(\.\s*)+/g, ". ")
    .trim();
const https = (u: string | undefined) => (u?.startsWith("//") ? `https:${u}` : u?.startsWith("https://") ? u : undefined);

export function nearlyNaturalDetail(r: Row): ProductDetail | undefined {
  const cents = toCents(r.price);
  if (cents == null || !r.handle) return undefined;
  const was = toCents(r.compare_at_price_max);
  const image = https(r.image) ?? https(r.featured_image?.url);
  const description = strip(r.body ?? "").slice(0, 3000);
  const parsed = ProductDetail.safeParse({
    id: productId("nearlynatural", String(r.id)),
    marketplace: "nearlynatural",
    url: `${BASE}/products/${r.handle}`,
    title: r.title,
    brand: r.vendor || "Nearly Natural",
    price: usd(cents),
    listPrice: was != null && was > cents ? usd(was) : undefined,
    deal: was != null && was > cents ? { label: `was $${(was / 100).toFixed(2)}` } : undefined,
    imageUrls: image ? [image] : [],
    inStock: r.available,
    snippet: description.slice(0, 200) || undefined,
    source: { via: "recipe", confidence: 0.9, fetchedAt: new Date().toISOString() },
    description: description || r.title,
    specs: Object.fromEntries([["Type", r.type ?? ""], ["Tags", (r.tags ?? []).slice(0, 8).join(", ")]].filter(([, v]) => v)),
  });
  return parsed.success ? parsed.data : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = () => new Date().toISOString();

async function suggest(q: string): Promise<Result<Row[]>> {
  const url = `${BASE}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=10`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(8000) }).catch(() => undefined);
    if (res?.status === 429) {
      await sleep(1500);
      continue;
    }
    if (!res?.ok) return err("timeout", `Nearly Natural search failed (${res?.status ?? "no response"})`, true);
    const data = (await res.json().catch(() => null)) as { resources?: { results?: { products?: Row[] } } } | null;
    return ok(data?.resources?.results?.products ?? []);
  }
  return err("rate_limited", "Nearly Natural is rate limiting searches", true);
}

export class NearlyNaturalFlow {
  /** Search rows already carry the full description, so details come from here. */
  private details = new Map<string, ProductDetail>();

  async search(query: string, emit: Emit, price: PriceRange = {}): Promise<Result<ProductCandidate[]>> {
    emit({ stage: "searching", marketplace: "nearlynatural", message: "Checking Nearly Natural, a fake-plant shop", at: at() });
    const q = nearlyNaturalQuery(query) || "plant";
    const wantsPot = /\b(planters?|pots?|vases?|baskets?)\b/i.test(query);
    // Every word must match on Shopify, and only 10 come back (big trees first). With fewer than 3 usable, also try
    // "mini <last word>" ("small green plant" → "mini plant"), which is where the under-$50 ones are.
    const last = q.split(" ").at(-1)!;
    const out: ProductCandidate[] = [];
    let total = 0;
    for (const term of [...new Set([q, `mini ${last}`])]) {
      if (out.length >= 3) break;
      const rows = await suggest(term);
      if (!rows.ok) {
        if (out.length) break;
        return rows;
      }
      total += rows.data.length;
      for (const r of rows.data) {
        // Empty pots: type "Planter" / "Vase", or untyped with a pot title. "Plant in Planter" is a plant.
        const pot = /^(planter|vase|basket|container)s?$/i.test(r.type ?? "") || (!r.type && /planter|vase|basket/i.test(r.title) && !/artificial|plant\b|silk/i.test(r.title));
        if (pot && !wantsPot) continue;
        const d = nearlyNaturalDetail(r);
        if (!d || d.inStock === false || out.some((c) => c.id === d.id)) continue;
        if (price.maxCents != null && d.price.cents > price.maxCents) continue;
        if (price.minCents != null && d.price.cents < price.minCents) continue;
        this.details.set(d.id, d);
        out.push(ProductCandidate.parse(d));
      }
    }
    console.log(`nearlynatural search "${q}": ${total} products → ${out.length} in stock and in budget`);
    return ok(out);
  }

  async getDetail(c: ProductCandidate, emit: Emit): Promise<Result<ProductDetail>> {
    emit({ stage: "reading_product", marketplace: "nearlynatural", message: "Reading the Nearly Natural listing", at: at() });
    const d = this.details.get(c.id);
    return d ? ok(d) : err("not_found", `No Nearly Natural listing for ${c.id}`);
  }
}
