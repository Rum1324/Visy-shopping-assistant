import {
  err,
  ok,
  productId,
  ProductCandidate,
  ProductDetail,
  RawReview,
  type Emit,
  type Result,
} from "@visy/contracts";
import type { FlowDriver } from "../driver/flow.ts";

/**
 * C-WMT: live walmart.com search and product detail. Walmart is a Next.js site: every search and product page ships
 * its data as JSON in <script id="__NEXT_DATA__">, so we read that instead of the markup (no AI, no recipe).
 * Checked live on 2026-10-24 ("picnic blanket"). Everything read here is page data: UNTRUSTED.
 */

const NEXT_DATA = `JSON.parse(document.getElementById('__NEXT_DATA__').textContent)`;
// Walmart's bot check redirects to /blocked ("Robot or human? Press & hold"). isBlocked() catches it; this only ends the wait early.
const READY_JS = `(document.readyState !== 'loading' && !!document.getElementById('__NEXT_DATA__')) || /^\\/blocked/.test(location.pathname)`;

/** Search results: the grid stacks, then carousels ("4 stars and above"), deduped by item id. */
const RESULTS_JS = String.raw`(() => {
  let d;
  try { d = ${NEXT_DATA}; } catch { return []; }
  const stacks = d?.props?.pageProps?.initialData?.searchResult?.itemStacks || [];
  const ordered = [...stacks.filter((s) => s.layoutEnum !== 'CAROUSEL'), ...stacks.filter((s) => s.layoutEnum === 'CAROUSEL')];
  const seen = new Set();
  const out = [];
  for (const s of ordered) for (const it of s.items || []) {
    if (it.__typename !== 'Product' || !it.usItemId || !it.name || seen.has(String(it.usItemId))) continue;
    seen.add(String(it.usItemId));
    const line = (types, key) => {
      for (const l of it.priceInfo?.priceDetails?.priceLines || []) if (types.includes(l.lineType)) for (const v of l.values || []) if (v.key === key) return v.value;
      return null;
    };
    const tile = (it.badges?.groupsV2 || []).find((g) => g.name === 'ProdTileBadgeModule5');
    const ship = (tile?.members || []).map((m) => (m.content || []).map((c) => c.value).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    out.push({
      id: String(it.usItemId),
      title: it.name,
      brand: it.brand || null,
      price: line(['CURRENT_PRICE', 'DISCOUNTED_PRICE'], 'PRICE') ?? line(['OPTIONS', 'OPTIONS_RANGE'], 'LOW_PRICE') ?? (it.price ?? null),
      wasPrice: line(['COMPARISON'], 'WAS_PRICE'),
      rating: typeof it.averageRating === 'number' ? it.averageRating : null,
      reviews: typeof it.numberOfReviews === 'number' ? it.numberOfReviews : null,
      image: it.imageInfo?.thumbnailUrl || null,
      path: (it.canonicalUrl || '').split('?')[0] || null,
      availability: it.availabilityStatusV2?.value || null,
      flags: (it.badges?.flags || []).map((f) => ({ key: f.key || '', text: f.text || '' })),
      delivery: ship.find((t) => /shipping/i.test(t)) || ship[0] || null,
      sponsored: !!it.isSponsoredFlag,
    });
  }
  return out;
})()`;

/** Product page: product, idml (description, specs) and the ~10 reviews the page ships with. */
const DETAIL_JS = String.raw`(() => {
  let d;
  try { d = ${NEXT_DATA}.props.pageProps.initialData.data; } catch { return null; }
  const p = d?.product;
  if (!p) return null;
  const idml = d.idml || {};
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const pi = p.priceInfo || {};
  const ship = (p.fulfillmentOptions || []).find((o) => o.type === 'SHIPPING');
  return {
    title: p.name || null,
    brand: p.brand || null,
    price: pi.currentPrice?.price ?? null,
    wasPrice: pi.wasPrice?.price ?? null,
    savings: pi.savings?.priceString || null,
    flags: (p.badges?.flags || []).map((f) => ({ key: f.key || '', text: f.text || '' })),
    rating: typeof p.averageRating === 'number' ? p.averageRating : null,
    reviews: typeof p.numberOfReviews === 'number' ? p.numberOfReviews : null,
    images: (p.imageInfo?.allImages || []).map((i) => String(i.url || '').split('?')[0]).filter(Boolean).slice(0, 8),
    availability: p.availabilityStatus || null,
    shipEta: ship?.speedDetails?.fulfillmentBadge || null,
    shipFree: ship?.speedDetails?.freeFulfillment ?? null,
    lowStock: ship?.isLowInStock ? (ship.availableQuantity ?? 0) : null,
    description: strip(idml.shortDescription || p.shortDescription).slice(0, 3000) || null,
    bullets: (String(idml.longDescription || '').match(/<li[^>]*>[\s\S]*?<\/li>/gi) || []).map(strip).filter(Boolean).slice(0, 12),
    specs: (idml.specifications || []).map((s) => [strip(s.name), strip(s.value)]).filter((kv) => kv[0] && kv[1]).slice(0, 40),
    variants: (p.variantCriteria || []).map((v) => ({ name: v.name || '', options: (v.variantList || []).map((o) => o.name).filter(Boolean).slice(0, 30) })).filter((v) => v.name && v.options.length).slice(0, 6),
    customerReviews: (d.reviews?.customerReviews || []).map((r) => ({
      id: String(r.reviewId || ''),
      rating: typeof r.rating === 'number' ? r.rating : null,
      title: r.reviewTitle || '',
      body: r.reviewText || '',
      date: r.reviewSubmissionTime || '',
      author: r.userNickname || null,
      verified: (r.badges || []).some((b) => b.id === 'VerifiedPurchaser'),
    })),
  };
})()`;

/** Named page scripts (navigator/scripts.ts). Run `npm run gen-indexer -w @visy/server` after changing them. */
export const WALMART_SCRIPTS = {
  "walmart.ready": READY_JS,
  "walmart.results": RESULTS_JS,
  "walmart.detail": DETAIL_JS,
};

type Flag = { key: string; text: string };
export type WalmartResult = {
  id: string;
  title: string;
  brand: string | null;
  price: string | number | null;
  wasPrice: string | number | null;
  rating: number | null;
  reviews: number | null;
  image: string | null;
  path: string | null;
  availability: string | null;
  flags: Flag[];
  delivery: string | null;
  sponsored: boolean;
};
type ScrapedReview = { id: string; rating: number | null; title: string; body: string; date: string; author: string | null; verified: boolean };
export type WalmartDetail = {
  title: string | null;
  brand: string | null;
  price: number | null;
  wasPrice: number | null;
  savings: string | null;
  flags: Flag[];
  rating: number | null;
  reviews: number | null;
  images: string[];
  availability: string | null;
  shipEta: string | null;
  shipFree: boolean | null;
  lowStock: number | null;
  description: string | null;
  bullets: string[];
  specs: [string, string][];
  variants: { name: string; options: string[] }[];
  customerReviews: ScrapedReview[];
};

/** 20.62, "20.62", "$1,234.5" → cents. */
export function toCents(v: string | number | null | undefined): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : undefined;
  const m = v?.replace(/,/g, "").match(/(\d+)(?:\.(\d{1,2}))?/);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : undefined;
}
const usd = (cents: number) => ({ cents, currency: "USD" as const });

// Price badges only. "Best seller", "Overall pick" and "In 25+ people's carts" are not deals.
const DEAL_KEYS = /ROLLBACK|CLEARANCE|REDUCED|PRICE_DROP|SPECIAL_BUY|DEAL|FLASH|SAVINGS/i;
const dealOf = (flags: Flag[], savings?: string | null) => {
  const labels = flags.filter((f) => DEAL_KEYS.test(f.key) && f.text).map((f) => f.text);
  if (!labels.length) return undefined;
  if (savings) labels.push(savings.replace(/^SAVE/, "save"));
  return { label: labels.join(", ").slice(0, 120) };
};
const inStockOf = (a: string | null) => (a === "IN_STOCK" ? true : a && /OUT_OF_STOCK|NOT_AVAILABLE/.test(a) ? false : undefined);
const httpsUrl = (u: string | null | undefined) => (u && /^https:\/\//.test(u) ? u : undefined);

/** Search rows → candidates: organic, priced, at most `limit`. */
export function walmartCandidates(rows: WalmartResult[], limit = 30): ProductCandidate[] {
  const out: ProductCandidate[] = [];
  for (const r of rows) {
    if (r.sponsored) continue;
    const cents = toCents(r.price);
    if (cents == null) continue;
    const was = toCents(r.wasPrice);
    const parsed = ProductCandidate.safeParse({
      id: productId("walmart", r.id),
      marketplace: "walmart",
      url: `https://www.walmart.com${r.path?.startsWith("/ip/") ? r.path : `/ip/${r.id}`}`,
      title: r.title,
      brand: r.brand ?? undefined,
      price: usd(cents),
      listPrice: was != null && was > cents ? usd(was) : undefined,
      deal: dealOf(r.flags),
      rating: r.rating != null && r.rating >= 0 && r.rating <= 5 ? r.rating : undefined,
      reviewCount: r.reviews ?? undefined,
      imageUrls: httpsUrl(r.image) ? [r.image] : [],
      shipping: r.delivery ? { eta: r.delivery, free: /free/i.test(r.delivery) } : undefined,
      inStock: inStockOf(r.availability),
      source: { via: "recipe", confidence: 0.9, fetchedAt: new Date().toISOString() },
    });
    if (parsed.success) out.push(parsed.data);
    if (out.length >= limit) break;
  }
  return out;
}

/** "9/28/2026" → ISO, or undefined. */
export function walmartDate(s: string): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]))).toISOString() : undefined;
}

export function walmartReviews(itemId: string, scraped: ScrapedReview[]): RawReview[] {
  const out: RawReview[] = [];
  for (const r of scraped) {
    if (!r.id || !r.body) continue;
    const parsed = RawReview.safeParse({
      id: `walmart:${r.id}`,
      productId: productId("walmart", itemId),
      source: "retailer",
      url: `https://www.walmart.com/reviews/product/${itemId}`,
      author: r.author ?? undefined,
      rating: r.rating ?? undefined,
      title: r.title || undefined,
      body: r.body.slice(0, 4000),
      date: walmartDate(r.date),
      verifiedPurchase: r.verified,
      untrusted: true,
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Product page data on top of the search candidate. Search fields win where the page has nothing. */
export function walmartDetail(c: ProductCandidate, d: WalmartDetail): ProductDetail {
  const itemId = c.id.replace(/^walmart:/, "");
  const cents = toCents(d.price) ?? c.price.cents;
  const was = toCents(d.wasPrice);
  const banners = d.lowStock != null ? [d.lowStock > 0 ? `Only ${d.lowStock} left` : "Low stock"] : [];
  const images = d.images.filter((u) => httpsUrl(u));
  return ProductDetail.parse({
    ...c,
    title: d.title || c.title,
    brand: d.brand ?? c.brand,
    price: usd(cents),
    listPrice: was != null && was > cents ? usd(was) : was != null ? undefined : c.listPrice,
    deal: dealOf(d.flags, d.savings) ?? c.deal,
    rating: d.rating != null && d.rating >= 0 && d.rating <= 5 ? d.rating : c.rating,
    reviewCount: d.reviews ?? c.reviewCount,
    imageUrls: images.length ? images : c.imageUrls,
    shipping: c.shipping ?? (d.shipEta ? { eta: `Arrives ${d.shipEta.toLowerCase()}`, free: d.shipFree ?? undefined } : undefined),
    inStock: inStockOf(d.availability) ?? c.inStock,
    source: { via: "recipe", confidence: 0.9, fetchedAt: new Date().toISOString() },
    description: d.description || d.bullets.join(" ") || c.title,
    bullets: d.bullets,
    specs: Object.fromEntries(d.specs.map(([k, v]) => [k.slice(0, 80), v.slice(0, 300)])),
    banners,
    variants: d.variants,
    retailerReviews: walmartReviews(itemId, d.customerReviews),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = () => new Date().toISOString();

export class WalmartFlow {
  /** The search tab. */
  tabId?: number;
  /** item id → background tab with its product page, kept until the next search (so a page can be shown later). */
  productTabs = new Map<string, number>();

  constructor(private driver: FlowDriver) {}

  /** Navigates and waits for __NEXT_DATA__. A bot check goes to the user: we focus the tab and wait. Never solved by us. */
  private async load(tabId: number, url: string, emit: Emit): Promise<Result<{}>> {
    const r = await this.driver.navigate(tabId, url, "commit");
    if (!r.ok) return r;
    await this.driver.waitFor(tabId, "walmart.ready", 15_000);
    if (!(await this.driver.isBlocked(tabId))) return ok({});
    await this.driver.focus(tabId);
    emit({ stage: "searching", marketplace: "walmart", message: "Walmart is showing a press and hold check. Please do it in the tab I just brought up. I will not bypass it.", at: at() });
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      await sleep(2000);
      if (!(await this.driver.isBlocked(tabId).catch(() => true))) {
        await this.driver.waitFor(tabId, "walmart.ready", 15_000);
        return ok({});
      }
    }
    return err("blocked", "Walmart bot check not solved");
  }

  async closeProductTabs() {
    for (const tabId of this.productTabs.values()) await this.driver.closeTab(tabId).catch(() => {});
    this.productTabs.clear();
  }

  async search(query: string, emit: Emit, limit = 30): Promise<Result<ProductCandidate[]>> {
    emit({ stage: "searching", marketplace: "walmart", message: "Searching Walmart now", at: at() });
    await this.closeProductTabs();
    if (this.tabId === undefined) {
      const t = await this.driver.openTab("about:blank", { background: true });
      if (!t.ok) return t;
      this.tabId = t.data.tabId;
    }
    const l = await this.load(this.tabId, `https://www.walmart.com/search?q=${encodeURIComponent(query)}`, emit);
    if (!l.ok) {
      this.tabId = undefined; // the tab may be gone; open a fresh one next time
      return l;
    }
    const rows = await this.driver.extract<WalmartResult[]>(this.tabId, "walmart.results");
    const candidates = walmartCandidates(rows, limit);
    console.log(`walmart search: ${rows.length} items, ${rows.filter((r) => r.sponsored).length} sponsored → ${candidates.length} candidates`);
    return candidates.length ? ok(candidates) : err("parse_failed", "Walmart results had no priced organic products");
  }

  /** Opens the product in its own background tab and reads it. Retailer reviews are the ~10 the page ships with. */
  async getDetail(c: ProductCandidate, emit: Emit): Promise<Result<ProductDetail>> {
    emit({ stage: "reading_product", message: "Reading the Walmart product page", marketplace: "walmart", at: at() });
    const itemId = c.id.replace(/^walmart:/, "");
    let tabId = this.productTabs.get(itemId);
    if (tabId === undefined) {
      const t = await this.driver.openTab("about:blank", { background: true });
      if (!t.ok) return t;
      tabId = t.data.tabId;
      this.productTabs.set(itemId, tabId);
    }
    const l = await this.load(tabId, c.url, emit);
    if (!l.ok) return l;
    const d = await this.driver.extract<WalmartDetail | null>(tabId, "walmart.detail");
    if (!d) return err("parse_failed", "Walmart product page had no product data");
    return ok(walmartDetail(c, d));
  }
}
