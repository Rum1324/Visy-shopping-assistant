import { err, ok, productId, ProductCandidate, RawReview, type Emit, type ProductDetail, type Result } from "@visy/contracts";
import type { FlowDriver } from "../driver/flow.ts";
import { ClaudeRecipeWriter, extractWithRecipes, RecipeCache, type RawDetail, type RecipeFields, type RecipeWriter } from "../recipes.ts";

/**
 * C-TGT: live target.com search and product detail, same shape as AmazonFlow (sites/amazon.ts).
 * Target renders everything client-side, so every read waits for its cards / blocks to appear first.
 * Markup checked by hand on live target.com, 2026-10-24: cards and blocks are keyed by data-test attributes;
 * the class names are hashed and change between builds, so nothing here uses them.
 */

/** One search card as page text (untrusted). `lines` are the card's text blocks in order: badges, price, deal, fulfillment. */
export type TargetRow = {
  tcin: string;
  path: string;
  title: string;
  brand: string | null;
  lines: string[];
  rating: string | null;
  image: string | null;
  sponsored: boolean;
};

const CARD_SEL = '[data-test="ListingPageProductListing"]';
const CHALLENGE_JS = `/captcha|robot or human|access denied/i.test(document.title)`;
// Text blocks of a card, minus the title (h3) and the star widget (its aria-label has rating + count).
const RESULTS_JS = `Array.from(document.querySelectorAll('${CARD_SEL}')).map((c) => {
  const t = (e) => (e ? e.textContent || '' : '').replace(/\\s+/g, ' ').trim();
  const a = c.querySelector('a[href*="/A-"]');
  const href = a ? a.getAttribute('href') || '' : '';
  const h3 = c.querySelector('h3');
  const parts = h3 ? Array.from(h3.children).map(t).filter(Boolean) : [];
  const lines = Array.from(c.querySelectorAll('[data-test="text-quill"], [data-test="cdui-marker-v2"]'))
    .filter((e) => !e.closest('h3, [data-test="rating-stars"]') && !(e.getAttribute('data-test') === 'cdui-marker-v2' && e.querySelector('[data-test="text-quill"]')))
    .map(t).filter(Boolean);
  const aria = (c.querySelector('[data-test="product-listing-gallery-desktop-image-link"]')?.getAttribute('aria-label') || '').trim();
  const label = aria.replace(/\\s+Sponsored$/, '');
  return {
    tcin: (/\\/A-(\\d+)/.exec(href) || [])[1] || null,
    path: href.split('?')[0].split('#')[0],
    title: label || t(h3),
    brand: parts.length > 1 ? parts[0] : null,
    lines,
    rating: c.querySelector('[data-test="rating-stars"]')?.getAttribute('aria-label') || null,
    image: c.querySelector('img')?.getAttribute('src') || null,
    // Card text runs together ("...may varySponsoredAdd to cart"), so match the "Sponsored" block, not a word.
    sponsored: lines.some((l) => /^Sponsored$/i.test(l)) || /\\sSponsored$/.test(aria),
  };
}).filter((r) => r.tcin && r.title)`;

// Product page: delivery / pickup / stock lines from the buy box's Fulfillment region (whole page if it moves). "Ship to <zip>" is the user's own zip: skipped.
const FULFILLMENT_JS = `[...new Set(Array.from((document.querySelector('[role="region"][aria-label="Fulfillment"]') || document).querySelectorAll('[data-test="text-quill"]')).map((e) => (e.textContent || '').replace(/\\s+/g, ' ').trim())
  .filter((s) => s.length < 120 && /^(Arrives|Get it|Ships free|Shipping|Delivery|Same Day|Pickup|Ready within|Order pickup|Drive Up|Only \\d+ left|Out of stock|Sold out|Not available|Temporarily out)/i.test(s)))].slice(0, 6)`;
const REVIEWS_JS = `Array.from(document.querySelectorAll('[data-test="review-card--text"]')).map((b) => {
  let c = b;
  while (c.parentElement && !c.querySelector('[data-test="review-card--username"]')) c = c.parentElement;
  const t = (h) => (c.querySelector('[data-test="review-card--' + h + '"]')?.textContent || '').replace(/\\s+/g, ' ').trim();
  return { title: t('title'), body: (b.innerText || b.textContent || '').trim(), date: t('reviewTime'), author: t('username') || null, rating: parseFloat(t('ratings')) || null, verified: !!c.querySelector('[data-test="review-card--verified-purchase"]'), syndicated: !!c.querySelector('[data-test="review-card--syndicated-badge"]') };
}).filter((r) => r.body)`;

/** Named page scripts (navigator/scripts.ts); the extension runs them by name. Whatever they return is UNTRUSTED. */
export const TARGET_SCRIPTS = {
  "target.results": RESULTS_JS,
  // JS-rendered: the HTML arrives with no cards. Ready = one titled card, the "no results" block, or a bot check.
  "target.resultsReady": `!!document.querySelector('${CARD_SEL} h3') || !!document.querySelector('[data-test="nlr-container"]') || ${CHALLENGE_JS}`,
  // The first page has ~24-30 cards; they stream in after the first one.
  "target.cardsReady": `document.querySelectorAll('${CARD_SEL} h3').length >= 20`,
  "target.detailReady": `!!document.querySelector('[data-test="product-title"]') && !!document.querySelector('[data-test="product-price"], [data-test="price-cdui-row"]') || ${CHALLENGE_JS}`,
  "target.fulfillment": FULFILLMENT_JS,
  // Reviews load when their section scrolls into view. Scrolling only, never a click.
  "target.scrollReviews": `void document.querySelector('[data-test="ReviewsDashboard"], [data-test="reviews-heading"]')?.scrollIntoView()`,
  "target.reviewsReady": `!!document.querySelector('[data-test="review-card--text"]')`,
  "target.reviews": REVIEWS_JS,
};

/** C3 seed recipe for target.com product pages, checked by hand on a live page (2026-10-24). Replayed first: no AI. */
export const TARGET_PRODUCT_SEED: RecipeFields = {
  title: { css: '[data-test="product-title"]', attr: null },
  price: { css: '[data-test="product-price"]', attr: null },
  listPrice: { css: '[data-test="product-regular-price"]', attr: null },
  deal: { css: '[data-test="price-cdui-row"] [data-test="cdui-marker"]', attr: null },
  prime: null,
  rating: { css: '[data-test="ratingFeedbackContainer"] [aria-label^="Average customer rating"]', attr: "aria-label" },
  reviewCount: { css: '[data-test="ratingFeedbackContainer"] [aria-label^="Average customer rating"]', attr: "aria-label" },
  brand: { css: '[data-test="shopAllBrandLink"]', attr: null },
  availability: null,
  delivery: null,
  bullets: { css: '[data-test="@web/ProductDetailPageHighlights"] li', attr: null },
  description: { css: '[data-test="item-details-description"]', attr: null },
  banners: null,
  images: { css: '[data-test^="image-gallery-item"] img', attr: "src" },
  specRows: null,
  specKey: null,
  specValue: null,
  variantGroups: null,
  variantName: null,
  variantOption: null,
};

const money = (s: string | null | undefined): { cents: number; currency: "USD" } | undefined => {
  const m = s?.replace(/,/g, "").match(/\$\s?(\d+)(?:\.(\d{1,2}))?/);
  return m ? { cents: Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")), currency: "USD" } : undefined;
};
/** "Average customer rating is 4.8 out of 5 stars with 2466 reviews." → { rating, reviewCount }. */
export function ratingLabel(s: string | null | undefined) {
  const r = Number(/([\d.]+) out of 5/.exec(s ?? "")?.[1]);
  const n = Number(/with ([\d,]+) review/.exec(s ?? "")?.[1]?.replace(/,/g, ""));
  return { rating: r >= 0 && r <= 5 ? r : undefined, reviewCount: Number.isInteger(n) ? n : undefined };
}
const image = (u: string | null | undefined) => (u && /^https:\/\//.test(u) ? u.split("?")[0] : undefined);

const DEAL = /^(Sale|Clearance|Select items on clearance|Lower price on select items|Price drop|Deal of the day|Buy \d|Save \$|\$\d+(\.\d\d)? off|\d+% off)/i;
const FULFILL = /^(Shipping|Delivery|Pickup|Ships|Order pickup|Drive Up|Same Day|Arrives|Get it|Ready within)/i;
const NO_STOCK = /out of stock|sold out|not available|temporarily out/i;
const MARKER = /^(Bestseller|Highly rated|New at|Only at|Online only|Limited stock|\S+ bought in last month)/i;

/** Search card → ProductCandidate, or null (sponsored, unpriced). A price range ("$8.25 - $20.00") keeps its low end. */
export function targetCandidate(row: TargetRow, fetchedAt = new Date().toISOString()): ProductCandidate | null {
  if (row.sponsored) return null;
  const priceLine = row.lines.find((l) => /^\$\d/.test(l));
  const price = money(priceLine);
  if (!price) return null;
  const listPrice = money(/reg\s*(\$[\d,.]+)/.exec(priceLine ?? "")?.[1]);
  const deals = row.lines.filter((l) => DEAL.test(l));
  const fulfill = row.lines.filter((l) => FULFILL.test(l) && !/^Shipping dates may vary/i.test(l));
  const eta = fulfill.filter((l) => !/ships free|free shipping/i.test(l));
  const { rating, reviewCount } = ratingLabel(row.rating);
  const notes = row.lines.filter((l) => MARKER.test(l));
  if (/ - \$/.test(priceLine ?? "")) notes.push(`Price varies by option: ${priceLine!.replace(/\s*reg.*$/, "")}`);
  const img = image(row.image);
  return ProductCandidate.parse({
    id: productId("target", `A-${row.tcin}`),
    marketplace: "target",
    url: `https://www.target.com${row.path.startsWith("/p/") ? row.path : `/p/-/A-${row.tcin}`}`,
    title: row.title,
    brand: row.brand?.replace(/[™®]/g, "").trim() || undefined,
    price,
    listPrice: listPrice && listPrice.cents > price.cents ? listPrice : undefined,
    deal: deals.length ? { label: deals.join(", ").slice(0, 120), requiresMembership: deals.some((d) => /circle/i.test(d)) ? "Target Circle" : undefined } : undefined,
    rating,
    reviewCount,
    imageUrls: img ? [img] : [],
    shipping: fulfill.length ? { eta: eta.join("; ") || undefined, free: fulfill.some((l) => /ships free|free shipping/i.test(l)) || undefined } : undefined,
    inStock: !row.lines.some((l) => NO_STOCK.test(l)),
    snippet: notes.join(". ") || undefined,
    source: { via: "recipe", confidence: 0.9, fetchedAt },
  });
}

/** Recipe output + buy-box lines (untrusted page text) → ProductDetail fields. Missing fields stay undefined / empty. */
export function targetFields(raw: RawDetail, fulfillment: string[] = []) {
  const { rating, reviewCount } = ratingLabel(raw.rating ?? raw.reviewCount);
  const price = money(raw.price);
  const listPrice = money(raw.listPrice);
  const lines = fulfillment.filter((l) => !NO_STOCK.test(l) && !/^Only \d+ left/i.test(l));
  return {
    title: raw.title ?? undefined,
    brand: raw.brand?.replace(/^Shop all\s+/i, "").replace(/[™®]/g, "").trim() || undefined,
    price,
    listPrice: listPrice && price && listPrice.cents > price.cents ? listPrice : undefined,
    deal: raw.deal ? { label: raw.deal.slice(0, 120), requiresMembership: /circle/i.test(raw.deal) ? "Target Circle" : undefined } : undefined,
    rating,
    reviewCount,
    imageUrls: [...new Set(raw.images.map(image).filter((u): u is string => !!u))].slice(0, 8),
    shipping: lines.length
      ? { eta: lines.filter((l) => !/ships free|free shipping/i.test(l)).join("; ") || undefined, free: lines.some((l) => /ships free|free shipping/i.test(l)) || undefined }
      : undefined,
    inStock: fulfillment.some((l) => NO_STOCK.test(l)) ? false : lines.length ? true : undefined,
    bullets: raw.bullets.map((b) => b.replace(/\s+/g, " ").trim()).filter(Boolean),
    description: raw.description ?? undefined,
    banners: fulfillment.filter((l) => /^Only \d+ left/i.test(l)),
  };
}

type ScrapedReview = { title: string; body: string; date: string; author: string | null; rating: number | null; verified: boolean; syndicated: boolean };

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
/** "5 July, 2026" → ISO, or undefined. */
export function targetReviewDate(s: string): string | undefined {
  const t = Date.parse(`${s.replace(/,/g, "")} UTC`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Target shows no review ids, so the id hashes author + date + body. Text is untrusted. */
export function toTargetReviews(tcin: string, url: string, scraped: ScrapedReview[]): RawReview[] {
  const out = new Map<string, RawReview>();
  for (const r of scraped) {
    const id = `target:${tcin}:${hash(`${r.author}|${r.date}|${r.body}`)}`;
    const parsed = RawReview.safeParse({
      id,
      productId: productId("target", `A-${tcin}`),
      source: "retailer",
      url,
      author: r.author ?? undefined,
      rating: r.rating ?? undefined,
      title: r.title || undefined,
      body: r.body.slice(0, 4000),
      date: targetReviewDate(r.date),
      verifiedPurchase: r.verified,
      untrusted: true,
    });
    if (parsed.success) out.set(id, parsed.data);
  }
  return [...out.values()];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = () => new Date().toISOString();

export class TargetFlow {
  tabId?: number;
  /** Sub-step timings for the last call, like AmazonFlow.marks. */
  marks: Record<string, number> = {};

  constructor(
    private driver: FlowDriver,
    private announce: (message: string) => void = (m) => console.log(m),
    private recipes: { cache: RecipeCache; writer: RecipeWriter } = { cache: new RecipeCache(), writer: new ClaudeRecipeWriter() },
  ) {}

  private mark(label: string, t0: number) {
    this.marks[label] = Math.round((this.marks[label] ?? 0) + performance.now() - t0);
  }

  /** A bot check goes to the human: bring the tab up, say so, wait up to 90 s. We never solve it. */
  private async blockedGate(): Promise<Result<{}>> {
    const tab = this.tabId!;
    if (!(await this.driver.isBlocked(tab))) return ok({});
    await this.driver.focus(tab);
    this.announce("Target is showing a bot check. Solve it in the browser tab I just brought up. I will not bypass it.");
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      if (!(await this.driver.isBlocked(tab))) return ok({});
      await sleep(2000);
    }
    return err("blocked", "Target bot check not solved");
  }

  private async goto(url: string) {
    const t0 = performance.now();
    if (this.tabId === undefined) {
      const t = await this.driver.openTab("about:blank", { background: true });
      if (!t.ok) return t;
      this.tabId = t.data.tabId;
    }
    const r = await this.driver.navigate(this.tabId, url, "commit");
    this.mark("navigate", t0);
    return r;
  }

  /** Organic, priced results in page order, up to `max`. Sponsored cards are dropped. */
  async search(query: string, emit: Emit = () => {}, max = 30): Promise<Result<ProductCandidate[]>> {
    this.marks = {};
    emit({ stage: "searching", marketplace: "target", message: "Searching Target now", at: at() });
    const g = await this.goto(`https://www.target.com/s?searchTerm=${encodeURIComponent(query)}`);
    if (!g.ok) return g;
    const t0 = performance.now();
    await this.driver.waitFor(this.tabId!, "target.resultsReady", 15_000);
    this.mark("wait results", t0);
    const b = await this.blockedGate();
    if (!b.ok) return b;
    const t1 = performance.now();
    await this.driver.waitFor(this.tabId!, "target.cardsReady", 5000);
    this.mark("wait cards", t1);
    const rows = await this.driver.extract<TargetRow[]>(this.tabId!, "target.results");
    const fetchedAt = at();
    const candidates = rows.map((r) => targetCandidate(r, fetchedAt)).filter((c): c is ProductCandidate => !!c).slice(0, max);
    console.log(`target search: ${rows.length} cards, ${rows.filter((r) => r.sponsored).length} sponsored → ${candidates.length} candidates`, this.marks);
    return candidates.length ? ok(candidates) : err("parse_failed", rows.length ? "Target results had no priced organic products" : "no Target result cards found");
  }

  /** Navigator.getDetail for Target: seed recipe first (no AI), Claude-written recipe on a miss, then ~8 reviews if they load. */
  async getDetail(candidate: ProductCandidate, emit: Emit = () => {}): Promise<Result<ProductDetail>> {
    this.marks = {};
    const tcin = candidate.id.replace(/^target:A-/, "");
    emit({ stage: "reading_product", message: "Reading the Target product page", marketplace: "target", at: at() });
    const g = await this.goto(candidate.url);
    if (!g.ok) return g;
    const t0 = performance.now();
    await this.driver.waitFor(this.tabId!, "target.detailReady", 15_000);
    this.mark("wait detail", t0);
    const b = await this.blockedGate();
    if (!b.ok) return b;
    const tab = this.tabId!;
    const run = <T>(name: "recipe.replay" | "recipe.outline", arg: unknown) => this.driver.extract<T>(tab, name, arg);
    const t1 = performance.now();
    let raw = await run<RawDetail>("recipe.replay", TARGET_PRODUCT_SEED).catch(() => null);
    let via = "seed";
    if (!raw?.title || !raw.price) {
      const x = await extractWithRecipes("target:product", candidate.url, run, this.recipes.cache, this.recipes.writer);
      raw = x.raw;
      via = x.via;
    }
    this.mark("recipe", t1);
    console.log(`[recipe] target:product via ${via}`);
    const fulfillment = await this.driver.extract<string[]>(tab, "target.fulfillment").catch(() => []);
    emit({ stage: "reviews", message: "Reading Target reviews", marketplace: "target", at: at() });
    const t2 = performance.now();
    await this.driver.extract(tab, "target.scrollReviews").catch(() => {});
    await this.driver.waitFor(tab, "target.reviewsReady", 4000);
    const reviews = toTargetReviews(tcin, candidate.url, await this.driver.extract<ScrapedReview[]>(tab, "target.reviews").catch(() => []));
    this.mark("reviews", t2);
    const f = raw ? targetFields(raw, fulfillment) : undefined;
    return ok({
      ...candidate,
      title: f?.title || candidate.title,
      brand: f?.brand ?? candidate.brand,
      price: f?.price ?? candidate.price,
      listPrice: f?.price ? f.listPrice : candidate.listPrice,
      deal: f?.deal ?? candidate.deal,
      rating: f?.rating ?? candidate.rating,
      reviewCount: f?.reviewCount ?? candidate.reviewCount,
      imageUrls: f?.imageUrls.length ? f.imageUrls : candidate.imageUrls,
      shipping: f?.shipping ?? candidate.shipping,
      inStock: f?.inStock ?? candidate.inStock,
      source: raw ? { via: via === "claude" ? "claude" : "recipe", confidence: 0.9, fetchedAt: at() } : candidate.source,
      description: f?.description || f?.bullets.join(" ") || candidate.snippet || candidate.title,
      bullets: f?.bullets ?? [],
      specs: {},
      banners: f?.banners ?? [],
      variants: [],
      retailerReviews: reviews,
    });
  }
}
