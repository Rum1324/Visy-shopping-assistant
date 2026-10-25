import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { err, ok, ProductCandidate, ProductDetail, type Emit, type Need, type Result } from "@visy/contracts";
import type { PriceRange } from "./search-urls.ts";
import { isPlantSearch, nearlyNaturalQuery } from "./nearlynatural.ts";

/**
 * C-SHOPS: any Shopify store as a search-only specialty shop, keyed by domain. Every Shopify shop serves
 * /search/suggest.json (up to 10 products with price, image and full description), so one plain fetch per search
 * covers search AND detail. Product pages and /products/<handle>.js get rate limited (429) after a few
 * non-browser requests, so we never call them. No cart: add to cart opens the page for the shopper.
 *
 * Shops: plant searches always get Nearly Natural (C-PLANT demo). Anything else asks Claude for specialty Shopify
 * shops that fit the query, then checks each live (it must answer suggest.json with products for the query) before
 * using it. Good and bad domains are cached for the process. Everything read from a shop is page data: UNTRUSTED.
 *
 * Ids are `shopify:<domain>:<shopify product id>`, e.g. "shopify:nearlynatural.com:123".
 */

export type Shop = { domain: string; name: string; /** Spoken after the name: "a shop that only sells fake plants". */ about: string; plant?: boolean };

export const NEARLY_NATURAL: Shop = { domain: "nearlynatural.com", name: "Nearly Natural", about: "a shop that only sells fake plants", plant: true };

/** Hand-checked fallbacks for when Claude is unavailable or none of its picks answer. */
const SEED: [RegExp, Shop[]][] = [
  [/\b(coffee|espresso|pour[- ]?over|kettle|grinder|drip|french press|aeropress)\b/i, [
    { domain: "fellowproducts.com", name: "Fellow", about: "a coffee gear shop" },
  ]],
  [/\b(climb|climbing|chalk|bouldering|crash pad|harness|carabiner)\b/i, [
    { domain: "frictionlabs.com", name: "Friction Labs", about: "a climbing chalk shop" },
  ]],
];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
/** A public shop hostname only: no IPs, ports, paths, localhost or internal names. Claude's output is not trusted. */
const HOST = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.[a-z]{2,}$/;
const BIG = /(^|\.)(amazon|target|walmart|ebay|bestbuy|etsy)\.com$/;
export const validDomain = (d: string) => HOST.test(d) && !BIG.test(d) && !/\.(local|internal|localhost|lan|home|corp)$/.test(d);

export const shopifyId = (domain: string, nativeId: string | number) => `shopify:${domain}:${nativeId}`;
/** "shopify:nearlynatural.com:123" → { domain, nativeId }. */
export function parseShopifyId(id: string) {
  const m = /^shopify:([^:\s]+):(\S+)$/.exec(id);
  return m ? { domain: m[1]!, nativeId: m[2]! } : undefined;
}

/** domain → shop, filled as shops are picked. Read by progress/agent to name a shopify candidate's store. */
const known = new Map<string, Shop>([[NEARLY_NATURAL.domain, NEARLY_NATURAL]]);
/** The shops of the latest pick, for "Checking X too" progress lines. */
let current: Shop[] = [];
export const currentShops = () => current;
/** Names these shops for progress lines, spoken store names and "the last pick came from …". */
export function rememberShops(shops: Shop[]) {
  for (const s of shops) known.set(s.domain, s);
  current = shops;
}
export function shopOf(id: string): Shop | undefined {
  const p = parseShopifyId(id);
  return p ? (known.get(p.domain) ?? { domain: p.domain, name: p.domain, about: "a specialty shop" }) : undefined;
}

/** Store name for speech and progress: "Amazon", "Nearly Natural". */
export function storeName(c: { id: string; marketplace: string }) {
  if (c.marketplace === "shopify") return shopOf(c.id)?.name ?? "a specialty shop";
  if (c.marketplace === "nearlynatural") return "Nearly Natural";
  return c.marketplace[0]!.toUpperCase() + c.marketplace.slice(1);
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

export function shopifyDetail(shop: Shop, r: Row): ProductDetail | undefined {
  const cents = toCents(r.price);
  if (cents == null || !r.handle) return undefined;
  const was = toCents(r.compare_at_price_max);
  const image = https(r.image) ?? https(r.featured_image?.url);
  const description = strip(r.body ?? "").slice(0, 3000);
  const parsed = ProductDetail.safeParse({
    id: shopifyId(shop.domain, r.id),
    marketplace: "shopify",
    url: `https://${shop.domain}/products/${r.handle}`,
    title: r.title,
    brand: r.vendor || shop.name,
    price: usd(cents),
    listPrice: was != null && was > cents ? usd(was) : undefined,
    deal: was != null && was > cents ? { label: `was $${(was / 100).toFixed(2)}` } : undefined,
    imageUrls: image ? [image] : [],
    inStock: r.available,
    snippet: description.slice(0, 200) || undefined,
    source: { via: "recipe", confidence: 0.9, fetchedAt: new Date().toISOString() },
    description: description || r.title,
    specs: Object.fromEntries([["Shop", shop.name], ["Type", r.type ?? ""], ["Tags", (r.tags ?? []).slice(0, 8).join(", ")]].filter(([, v]) => v)),
  });
  return parsed.success ? parsed.data : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = () => new Date().toISOString();

/** `${domain}|${term}` → rows, so verifying a shop with the real query also serves the search that follows. */
const rowCache = new Map<string, { at: number; rows: Row[] }>();

async function suggest(domain: string, q: string, fetcher: typeof fetch = fetch): Promise<Result<Row[]>> {
  const key = `${domain}|${q}`;
  const hit = rowCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return ok(hit.rows);
  const url = `https://${domain}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=10`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetcher(url, { headers: { "user-agent": UA, accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(6000) }).catch(() => undefined);
    if (res?.status === 429) {
      await sleep(1500);
      continue;
    }
    if (!res?.ok) return err("timeout", `${domain} search failed (${res?.status ?? "no response"})`, true);
    const data = (await res.json().catch(() => null)) as { resources?: { results?: { products?: Row[] } } } | null;
    const rows = data?.resources?.results?.products;
    if (!Array.isArray(rows)) return err("parse_failed", `${domain} is not a Shopify search`);
    rowCache.set(key, { at: Date.now(), rows });
    return ok(rows);
  }
  return err("rate_limited", `${domain} is rate limiting searches`, true);
}

const FILLER = /\b(for|a|an|the|some|i|want|need|looking|buy|get|me|my|please|good|best|nice|cheap|under|\$?\d+(\.\d+)?|dollars?|bucks)\b/g;
/** Words for a shop search. Shopify ANDs every word, so fewer is better. Plant shops drop "fake" (all of it is). */
export function shopQuery(shop: Shop, query: string) {
  if (shop.plant) return nearlyNaturalQuery(query) || "plant";
  return query.toLowerCase().replace(FILLER, " ").replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim() || query.trim();
}

/** Full query, then the last two words, then the last word ("pour over coffee kettle" → "coffee kettle" → "kettle"). */
function terms(shop: Shop, query: string) {
  const q = shopQuery(shop, query);
  const words = q.split(" ");
  const last = words.at(-1)!;
  return [...new Set(shop.plant ? [q, `mini ${last}`] : [q, words.slice(-2).join(" "), last])];
}

/** Claude's shop ideas. Only the shopper's query goes in; no page text. */
const Ideas = z.object({
  shops: z.array(z.object({ domain: z.string(), name: z.string(), about: z.string() })).max(5),
});
const SYSTEM = `You suggest independent specialty online shops that run on Shopify, for a voice shopping assistant.
Given what a shopper wants, list up to 4 US-shipping specialty shops whose own storefront is on Shopify and that sell that kind of product.
Prefer focused brands or specialty retailers (for example a coffee gear shop for a kettle) over department stores and marketplaces.
Never list Amazon, Target, Walmart, eBay, Etsy or Best Buy. If no specialty shop fits (groceries, generic household items), return an empty list.
domain: the bare storefront hostname, like "fellowproducts.com". name: how to say the shop aloud. about: 3 to 7 words a person would say after the name, like "a coffee gear shop".`;

export type ShopIdeas = (query: string) => Promise<Shop[]>;

export function claudeShopIdeas(
  client = process.env.ANTHROPIC_API_KEY?.trim() ? new Anthropic({ baseURL: process.env.VISY_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" }) : null,
  model = process.env.VISY_SHOPS_MODEL ?? process.env.VISY_RELEVANCE_MODEL ?? "claude-haiku-5-5",
): ShopIdeas | null {
  if (!client) return null;
  return async (query) => {
    const res = await client.messages.parse(
      {
        model,
        max_tokens: 400,
        thinking: { type: "disabled" } as any,
        output_config: { effort: "low", format: zodOutputFormat(Ideas) },
        system: SYSTEM,
        messages: [{ role: "user", content: `The shopper wants: ${query.slice(0, 200)}` }],
      },
      { timeout: 4000, maxRetries: 0 },
    );
    return (res.parsed_output?.shops ?? [])
      .map((s) => ({ domain: s.domain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""), name: s.name.slice(0, 40), about: s.about.slice(0, 60) }))
      .filter((s) => validDomain(s.domain));
  };
}

/** Domains that answered suggest.json like a Shopify shop (true) or didn't (false). Kept for the process. */
const verified = new Map<string, boolean>();

/** A shop is usable for this query when it answers suggest.json with at least one product for one of the terms. */
export async function verifyShop(shop: Shop, query: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!validDomain(shop.domain) || verified.get(shop.domain) === false) return false;
  for (const term of terms(shop, query).slice(0, 2)) {
    const rows = await suggest(shop.domain, term, fetcher);
    if (!rows.ok) {
      // Not Shopify / dead domain: remember. Rate limits and timeouts may pass, so don't.
      if (rows.error.code === "parse_failed" || /\((404|403|401|410|no response)\)/.test(rows.error.message)) verified.set(shop.domain, false);
      return false;
    }
    verified.set(shop.domain, true);
    if (rows.data.length) return true;
  }
  return false;
}

const picks = new Map<string, Promise<Shop[]>>();

/**
 * 0–2 verified specialty shops for this need, cached per query (the agent asks before speaking, live.ts again to search).
 * `ideas` null (no API key, tests) → seed list only.
 */
export function pickShops(need: Pick<Need, "query"> & Partial<Pick<Need, "mustHaves" | "niceToHaves">>, ideas: ShopIdeas | null = defaultIdeas(), fetcher: typeof fetch = fetch): Promise<Shop[]> {
  const key = need.query.trim().toLowerCase();
  if (!picks.has(key)) {
    const p = choose(need, ideas, fetcher).catch((e) => {
      console.warn(`shops: pick failed for "${need.query}": ${e instanceof Error ? e.message : e}`);
      return [] as Shop[];
    });
    picks.set(key, p);
    // A failed or empty pick may just be a slow network; let the next search try again.
    void p.then((s) => !s.length && setTimeout(() => picks.delete(key), 60_000).unref?.());
  }
  return picks.get(key)!.then((s) => (rememberShops(s), s));
}

let ideasSingleton: ShopIdeas | null | undefined;
const defaultIdeas = () => (ideasSingleton === undefined ? (ideasSingleton = claudeShopIdeas()) : ideasSingleton);

async function choose(need: Pick<Need, "query"> & Partial<Pick<Need, "mustHaves" | "niceToHaves">>, ideas: ShopIdeas | null, fetcher: typeof fetch): Promise<Shop[]> {
  const t0 = performance.now();
  if (isPlantSearch(need)) return [NEARLY_NATURAL];
  const seeds = SEED.filter(([re]) => re.test(need.query)).flatMap(([, s]) => s);
  const fromClaude = ideas ? await ideas(need.query).catch((e) => (console.warn(`shops: Claude ideas failed: ${e?.message ?? e}`), [] as Shop[])) : [];
  const ideasOk = [...fromClaude, ...seeds].filter((s, i, all) => all.findIndex((o) => o.domain === s.domain) === i).slice(0, 5);
  // Different domains, so checking them at once doesn't burst any one shop.
  const ok = await Promise.all(ideasOk.map((s) => verifyShop(s, need.query, fetcher).catch(() => false)));
  const chosen = ideasOk.filter((_, i) => ok[i]).slice(0, 2);
  console.log(
    `shops: "${need.query}" Claude → [${fromClaude.map((s) => s.domain).join(", ")}], seeds → [${seeds.map((s) => s.domain).join(", ")}]; ` +
      `verified [${ideasOk.filter((_, i) => ok[i]).map((s) => s.domain).join(", ")}] → using [${chosen.map((s) => s.name).join(", ")}] in ${Math.round(performance.now() - t0)} ms`,
  );
  return chosen;
}

/** "plus Nearly Natural, a shop that only sells fake plants" / "plus Fellow, a coffee gear shop, and Friction Labs, …". */
export function shopsPhrase(shops: Shop[]) {
  return shops.length ? `plus ${shops.map((s) => `${s.name}, ${s.about}`).join(", and ")}` : "";
}

export class ShopifyFlow {
  /** Search rows already carry the full description, so details come from here. */
  private details = new Map<string, ProductDetail>();

  /** Searches each shop (in parallel, one domain each) and merges. Never fails the whole search for one bad shop. */
  async search(shops: Shop[], query: string, emit: Emit, price: PriceRange = {}): Promise<Result<ProductCandidate[]>> {
    const all = await Promise.all(shops.map((s) => this.searchShop(s, query, emit, price)));
    const out = all.flatMap((r) => (r.ok ? r.data : []));
    return out.length || all.some((r) => r.ok) ? ok(out) : (all[0] ?? ok([]));
  }

  private async searchShop(shop: Shop, query: string, emit: Emit, price: PriceRange): Promise<Result<ProductCandidate[]>> {
    emit({ stage: "searching", marketplace: "shopify", message: `Checking ${shop.name}, ${shop.about}`, at: at() });
    const wantsPot = /\b(planters?|pots?|vases?|baskets?)\b/i.test(query);
    const out: ProductCandidate[] = [];
    let total = 0;
    for (const term of terms(shop, query)) {
      if (out.length >= 3) break;
      const rows = await suggest(shop.domain, term);
      if (!rows.ok) {
        if (out.length) break;
        return rows;
      }
      total += rows.data.length;
      for (const r of rows.data) {
        // C-PLANT: empty pots: type "Planter" / "Vase", or untyped with a pot title. "Plant in Planter" is a plant.
        const pot = shop.plant && (/^(planter|vase|basket|container)s?$/i.test(r.type ?? "") || (!r.type && /planter|vase|basket/i.test(r.title) && !/artificial|plant\b|silk/i.test(r.title)));
        if (pot && !wantsPot) continue;
        const d = shopifyDetail(shop, r);
        if (!d || d.inStock === false || out.some((c) => c.id === d.id)) continue;
        if (price.maxCents != null && d.price.cents > price.maxCents) continue;
        if (price.minCents != null && d.price.cents < price.minCents) continue;
        this.details.set(d.id, d);
        out.push(ProductCandidate.parse(d));
      }
    }
    console.log(`shopify ${shop.domain} search "${query}": ${total} products → ${out.length} in stock and in budget`);
    return ok(out);
  }

  async getDetail(c: ProductCandidate, emit: Emit): Promise<Result<ProductDetail>> {
    const shop = shopOf(c.id);
    emit({ stage: "reading_product", marketplace: "shopify", message: `Reading the ${shop?.name ?? "shop"} listing`, at: at() });
    const d = this.details.get(c.id);
    return d ? ok(d) : err("not_found", `No ${shop?.name ?? "shop"} listing for ${c.id}`);
  }
}
