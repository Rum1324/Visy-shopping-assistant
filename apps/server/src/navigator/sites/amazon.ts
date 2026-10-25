import {
  err,
  ok,
  productId,
  RawReview,
  type ElementPicker,
  type Emit,
  type PageState,
  type ProductCandidate,
  type ProductDetail,
  type Result,
} from "@visy/contracts";
import type { FlowDriver } from "../driver/flow.ts";
import { pickWithChain, type ChainPick } from "../chain.ts";
import { strictPicker, type FindStep } from "../pickers/common.ts";
import type { MemoryPicker } from "../pickers/memory.ts";
import { ClaudeRecipeWriter, extractWithRecipes, RecipeCache, type Extracted, type RawDetail, type RecipeFields, type RecipeWriter } from "../recipes.ts";

export type AmazonResult = { asin: string; title: string; price: string | null; rating: string | null; reviews?: string | null; sponsored: boolean };

// Tier 0: deterministic extraction, no AI. Amazon's result cards are stable enough for a hackathon.
const RESULT_SEL = '[data-component-type="s-search-result"][data-asin]';
const RESULTS_JS = `Array.from(document.querySelectorAll('${RESULT_SEL}')).map((c) => ({
  asin: c.getAttribute('data-asin'),
  title: (c.querySelector('h2')?.innerText || '').trim(),
  price: c.querySelector('.a-price .a-offscreen')?.textContent?.trim() || null,
  rating: c.querySelector('.a-icon-alt')?.textContent?.trim() || null,
  reviews: (() => { const r = c.querySelector('[aria-label$="ratings"], [aria-label$="rating"], a[href*="customerReviews"] span'); return r ? (r.getAttribute('aria-label') || r.textContent || '').trim() || null : null; })(),
  sponsored: !!c.querySelector('.puis-sponsored-label-text, [aria-label*="Sponsored"]') || /^Sponsored/.test((c.innerText || '').trim()),
})).filter((r) => r.asin && r.title)`;

const SUBTOTAL_SEL = "#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox";
const SUBTOTAL_JS = `(document.querySelector('${SUBTOTAL_SEL}')?.innerText || '').trim()`;
const CHALLENGE_JS = `!!document.querySelector('#checkpointForm, form[action*=validateCaptcha]')`;
// After Add to Cart Amazon either navigates (cart / smart wagon), shows an "Added to cart" sheet, or offers a warranty.
const ADDED_JS =
  `location.href !== arg || /added to (your )?cart/i.test(document.body.innerText.slice(0, 20000)) || !!document.querySelector('#attachSiNoCoverage, #attach-warranty-pane, #NATC_SMART_WAGON_CONF_MSG_SUCCESS, #sw-atc-confirmation')`;
const WARRANTY_JS = `!!document.querySelector('#attachSiNoCoverage, #attach-warranty-pane')`;

// C2: reviews. Same data-hook markup on the product page ("Top reviews", ~8) and on /product-reviews/ (10 per page).
// Text is untrusted: we only read it, and it goes out as RawReview { untrusted: true }.
const REVIEW_SEL = '[data-hook="review"]';
// Two markups seen: classic (review-title / review-body, id "customer_review-R…") and 2026 product page
// (reviewTitle / reviewText, id "R…"). Hidden teaser helpers are display:none, so innerText skips them.
const REVIEWS_JS = `Array.from(document.querySelectorAll('${REVIEW_SEL}')).map((r) => {
  const q = (...hs) => hs.map((h) => r.querySelector('[data-hook="' + h + '"]')).find(Boolean);
  const stars = r.querySelector('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"], .review-rating')?.textContent || '';
  const lines = (el) => (el?.innerText || '').split('\\n').map((l) => l.trim()).filter(Boolean);
  const title = lines(q('reviewTitle', 'review-title')).filter((l) => !/out of 5 stars/.test(l)).join(' ');
  const body = lines(q('reviewText', 'review-body')).filter((l) => !/^(Read more|See more|Report|Helpful|Click to play video)$/i.test(l)).join('\\n');
  return {
    id: (r.id || '').replace(/^customer_review(_foreign)?-/, ''),
    rating: parseFloat(stars) || null,
    title,
    body,
    date: q('review-date')?.innerText?.trim() || '',
    author: r.querySelector('.a-profile-name')?.textContent?.trim() || null,
    verified: !!q('avp-badge', 'avp-badge-linkless'),
  };
}).filter((r) => /^R[A-Z0-9]+$/.test(r.id) && r.body)`;
const REVIEWS_READY_JS = `!!document.querySelector('${REVIEW_SEL}') || /\\/ap\\/signin/.test(location.pathname) || ${CHALLENGE_JS} || /no customer reviews/i.test(document.body?.innerText || '')`;
const SHOW_MORE_SEL = '[data-hook="show-more-button"]';
const NEXT_PAGE_JS = `document.querySelector('.a-pagination .a-last:not(.a-disabled) a')?.href || null`;
// Fallback when there's no recipe and Claude can't write one (no API key, API down).
const DETAIL_JS = `({
  bullets: Array.from(document.querySelectorAll('#feature-bullets li, #productFactsDesktopExpander li')).map((l) => l.innerText.trim()).filter(Boolean).slice(0, 10),
  description: (document.querySelector('#productDescription')?.innerText || '').trim().slice(0, 3000),
})`;

/**
 * Named page scripts (navigator/scripts.ts): the extension can't eval strings, so every in-page read or wait
 * here has a name. `arg` is the script's one JSON argument.
 */
export const AMAZON_SCRIPTS = {
  "amazon.results": RESULTS_JS,
  "amazon.resultsReady": `!!document.querySelector('${RESULT_SEL}') || ${CHALLENGE_JS}`,
  // The candidate pool is ~30 per marketplace (narrow.ts), so wait for the whole results page, not the first few cards.
  "amazon.titlesReady": `document.querySelectorAll('${RESULT_SEL} h2').length >= 40 || document.readyState !== 'loading'`,
  "amazon.loadedOrChallenge": `document.readyState !== 'loading' || ${CHALLENGE_JS}`,
  "amazon.added": ADDED_JS,
  "amazon.warranty": WARRANTY_JS,
  "amazon.reviews": REVIEWS_JS,
  "amazon.reviewsReady": REVIEWS_READY_JS,
  "amazon.signin": `/\\/ap\\/signin/.test(location.pathname)`,
  "amazon.hasShowMore": `!!document.querySelector('${SHOW_MORE_SEL}')`,
  // A plain "Show 10 more reviews" button, never purchase-risk.
  "amazon.clickShowMore": `void document.querySelector('${SHOW_MORE_SEL}')?.click()`,
  "amazon.reviewsGrew": `document.querySelectorAll('${REVIEW_SEL}').length > arg || ${CHALLENGE_JS}`,
  "amazon.nextPage": NEXT_PAGE_JS,
  "amazon.productReviewsReady": `!!document.querySelector('${REVIEW_SEL}') || document.readyState === 'complete' || ${CHALLENGE_JS}`,
  "amazon.detailReady": `!!document.querySelector('#feature-bullets, #productDescription') || document.readyState === 'complete' || ${CHALLENGE_JS}`,
  "amazon.detail": DETAIL_JS,
  "amazon.titlePrice": `({ title: (document.querySelector("#productTitle")?.innerText || "").trim(), price: document.querySelector(".a-price .a-offscreen")?.textContent?.trim() || null })`,
  "amazon.subtotalReady": `!!document.querySelector('${SUBTOTAL_SEL}')`,
  "amazon.subtotal": SUBTOTAL_JS,
};

type ScrapedReview = { id: string; rating: number | null; title: string; body: string; date: string; author: string | null; verified: boolean };

/** "Reviewed in the United States on October 1, 2026" → ISO, or undefined. */
export function reviewDate(s: string): string | undefined {
  const m = /on (.+)$/.exec(s.trim());
  const t = m ? Date.parse(`${m[1]} UTC`) : NaN;
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function toRawReviews(asin: string, scraped: ScrapedReview[]): RawReview[] {
  const seen = new Set<string>();
  const out: RawReview[] = [];
  for (const r of scraped) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const parsed = RawReview.safeParse({
      id: `amazon:${r.id}`,
      productId: productId("amazon", asin),
      source: "retailer",
      url: `https://www.amazon.com/gp/customer-reviews/${r.id}`,
      author: r.author ?? undefined,
      rating: r.rating ?? undefined,
      title: r.title || undefined,
      body: r.body.slice(0, 4000),
      date: reviewDate(r.date),
      verifiedPurchase: r.verified,
      untrusted: true,
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * C3 fallback: a recipe checked by hand on two live product pages (2026-10-24). Used only when Claude can't write
 * one (no API key, API down); a Claude-written recipe replaces it on the next miss.
 */
export const AMAZON_PRODUCT_SEED: RecipeFields = {
  title: { css: "#productTitle", attr: null },
  price: { css: "#corePriceDisplay_desktop_feature_div #apex-pricetopay-accessibility-label, #corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen, #corePrice_feature_div .a-price .a-offscreen", attr: null },
  listPrice: { css: "#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen", attr: null },
  deal: { css: "#dealBadge_feature_div .a-badge-text, #dealBadgeSupportingText", attr: null },
  prime: { css: "#rightCol .a-icon-prime, #deliveryBlockMessage .a-icon-prime", attr: null },
  rating: { css: "#acrPopover", attr: "title" },
  reviewCount: { css: "#acrCustomerReviewText", attr: "aria-label" },
  brand: { css: "#bylineInfo", attr: null },
  availability: { css: "#availability .primary-availability-message, #availability", attr: null },
  delivery: { css: "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE", attr: null },
  bullets: { css: "#feature-bullets li .a-list-item", attr: null },
  description: { css: "#productDescription", attr: null },
  banners: { css: "#newerVersion_feature_div .a-section, #availability .a-color-price", attr: null },
  images: { css: "#altImages li.imageThumbnail img", attr: "src" },
  specRows: { css: "#productOverview_feature_div tr, #prodDetails tr, #detailBullets_feature_div li", attr: null },
  specKey: { css: "th, td.a-span3, .a-text-bold", attr: null },
  specValue: { css: "td.a-span9, td.prodDetAttrValue, th + td, .a-text-bold + span", attr: null },
  variantGroups: { css: "#twister-plus-inline-twister .inline-twister-row", attr: null },
  variantName: { css: ".dimension-text .a-color-secondary", attr: null },
  variantOption: { css: ".inline-twister-swatch img", attr: "alt" },
};

const money = (s: string | null): { cents: number; currency: "USD" } | undefined => {
  const m = s?.replace(/,/g, "").match(/\$\s?(\d+)(?:\.(\d{1,2}))?/);
  return m ? { cents: Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")), currency: "USD" } : undefined;
};
const clean = (s: string) => s.replace(/[\u200e\u200f]/g, "").replace(/\s+/g, " ").replace(/\s*:\s*$/, "").trim();

/** Large image URLs: data-a-dynamic-image is a JSON map of url → size; thumbnails drop their size token. */
export function imageUrls(values: string[]): string[] {
  const urls = values.flatMap((v) => {
    if (v.startsWith("{")) {
      try {
        return Object.keys(JSON.parse(v));
      } catch {
        return [];
      }
    }
    return [v];
  });
  const full = urls.filter((u) => /^https:\/\//.test(u)).map((u) => u.replace(/\._[A-Z0-9,_]+_\./, "."));
  return [...new Set(full)].slice(0, 8);
}

/** C3: recipe output (untrusted page text) → ProductDetail fields. Missing fields stay undefined / empty. */
export function amazonFields(raw: RawDetail) {
  const reviewCount = raw.reviewCount ? Number(/[\d,]+/.exec(raw.reviewCount)?.[0].replace(/,/g, "")) : NaN;
  const rating = raw.rating ? parseFloat(raw.rating) : NaN;
  const avail = raw.availability ?? "";
  const inStock = /in stock|only \d+ left|available to ship/i.test(avail) ? true : /unavailable|out of stock/i.test(avail) ? false : undefined;
  const specs: Record<string, string> = {};
  for (const [k, v] of raw.specs.slice(0, 40)) if (clean(k) && clean(v)) specs[clean(k).slice(0, 80)] ??= clean(v).slice(0, 300);
  const banners = [...raw.banners];
  if (/only \d+ left/i.test(avail) && !banners.includes(avail)) banners.push(avail);
  return {
    title: raw.title ?? undefined,
    brand: raw.brand?.replace(/^(Visit the |Brand: )/, "").replace(/ Store$/, "") || undefined,
    price: money(raw.price),
    listPrice: money(raw.listPrice),
    deal: raw.deal ? { label: raw.deal.slice(0, 120), requiresMembership: /prime/i.test(raw.deal) ? "Prime" : undefined } : undefined,
    rating: rating >= 0 && rating <= 5 ? rating : undefined,
    reviewCount: Number.isInteger(reviewCount) ? reviewCount : undefined,
    imageUrls: imageUrls(raw.images),
    shipping: raw.delivery || raw.prime ? { eta: raw.delivery ?? undefined, free: raw.delivery ? /free/i.test(raw.delivery) : undefined, membership: raw.prime ? "Prime" : undefined } : undefined,
    inStock,
    bullets: raw.bullets.map(clean).filter(Boolean),
    description: raw.description ?? undefined,
    specs,
    banners: banners.map(clean).filter(Boolean),
    variants: raw.variants.map((v) => ({ name: clean(v.name), options: v.options.map((o) => clean(o.replace(/^Click to select /i, ""))) })),
  };
}

export type ReviewsResult = { reviews: RawReview[]; pages: number; via: "reviews_page" | "product_page"; gated: boolean };

export const STEPS = {
  searchBox: { kind: "find_control", intent: "searchbox: Search Amazon | section: navigation bar", then: "type" },
  addToCart: { kind: "find_control", intent: "button: Add to Cart | section: buy box", then: "click" },
} satisfies Record<string, FindStep>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AmazonFlow {
  tabId?: number;
  /** C1b: asin → background tab that has the product page loaded and its elements embedded (undefined if preload failed). */
  private preloaded = new Map<string, Promise<number | undefined>>();
  private indexing: Promise<unknown> = Promise.resolve();
  /** Sub-step timings for the last call, for the demo's breakdown. */
  marks: Record<string, number> = {};
  /** C3: how the last getDetail read the page ("replay" = no AI). */
  lastExtract?: Omit<Extracted, "raw">;

  constructor(
    private driver: FlowDriver,
    private pickers: ElementPicker[],
    private memory?: MemoryPicker,
    private onBlocked: () => Promise<void> = async () => {},
    private recipes: { cache: RecipeCache; writer: RecipeWriter } = { cache: new RecipeCache(), writer: new ClaudeRecipeWriter() },
  ) {}

  private mark(label: string, t0: number) {
    this.marks[label] = Math.round((this.marks[label] ?? 0) + performance.now() - t0);
  }

  private async blockedGate(tabId = this.tabId!): Promise<Result<{}>> {
    if (!(await this.driver.isBlocked(tabId))) return ok({});
    await this.driver.focus(tabId);
    await this.onBlocked();
    return (await this.driver.isBlocked(tabId)) ? err("blocked", "bot check not solved") : ok({});
  }

  private async goto(url: string, waitUntil: "commit" | "domcontentloaded" = "commit") {
    const t0 = performance.now();
    if (this.tabId === undefined) {
      const t = await this.driver.openTab("about:blank", { background: true });
      if (!t.ok) return t;
      this.tabId = t.data.tabId;
    }
    const r = await this.driver.navigate(this.tabId, url, waitUntil);
    this.mark("navigate", t0);
    return r;
  }

  /**
   * Snapshot → pick → act, starting while the page is still loading, re-snapshotting every ~150 ms.
   * While loading: memory, plus Moss in strict mode (trusted only on an exact role+name match, since on a
   * partial page Moss would happily pick e.g. the nav's "Add to cart, shift, option, K" shortcut). Moss also
   * embeds the new element text as it streams in, so the work overlaps the network wait.
   * Full chain (Moss by gap, then Claude) once the DOM is ready or the deadline passes: at most one Claude call.
   */
  async step(step: FindStep, deadlineMs = 6000): Promise<Result<ChainPick>> {
    const fast = this.pickers.filter((p) => p.name !== "claude").map((p) => (p.name === "moss" ? strictPicker(p) : p));
    const end = performance.now() + deadlineMs;
    let attempts = 0;
    while (true) {
      attempts++;
      let t0 = performance.now();
      const ready = (await this.driver.extract<string>(this.tabId!, "readyState").catch(() => "loading")) !== "loading";
      const s = await this.driver.snapshot(this.tabId!);
      this.mark("snapshot", t0);
      if (!s.ok) {
        if (s.error.code === "blocked") {
          const g = await this.blockedGate();
          if (!g.ok) return g;
          continue;
        }
        if (performance.now() > end) return s;
        await sleep(150);
        continue;
      }
      const final = ready || performance.now() > end;
      t0 = performance.now();
      const pick = await pickWithChain(final ? this.pickers : fast, s.data, step, this.memory);
      this.mark("pick", t0);
      if (!pick.ok) {
        if (final) return pick;
        await sleep(150);
        continue;
      }
      const action =
        step.then === "type"
          ? ({ kind: "type", idx: pick.data.idx, text: step.text ?? "", submit: true } as const)
          : step.then === "select"
            ? ({ kind: "select", idx: pick.data.idx, value: step.text ?? "" } as const)
            : ({ kind: "click", idx: pick.data.idx } as const);
      t0 = performance.now();
      const r = await this.driver.act(this.tabId!, action);
      this.mark("act", t0);
      this.marks.attempts = attempts;
      if (!r.ok) return r;
      return ok(pick.data);
    }
  }

  /** viaUi=false uses the shortcut URL (fastest). viaUi=true types into the search box through the picker chain. */
  async search(query: string, viaUi = false): Promise<Result<AmazonResult[]>> {
    this.marks = {};
    await this.dropPreloads();
    if (viaUi) {
      const g = await this.goto("https://www.amazon.com/");
      if (!g.ok) return g;
      const r = await this.step({ ...STEPS.searchBox, text: query });
      if (!r.ok) return r;
    } else {
      const g = await this.goto(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`);
      if (!g.ok) return g;
    }
    const t0 = performance.now();
    await this.driver.waitFor(this.tabId!, "amazon.resultsReady", 10_000);
    this.mark("wait results", t0);
    const g = await this.blockedGate();
    if (!g.ok) return g;
    // The page streams in: cards can exist before their titles are parsed. Wait for 40 titled cards or DOM ready.
    const t1 = performance.now();
    await this.driver.waitFor(this.tabId!, "amazon.titlesReady", 8000);
    this.mark("wait titles", t1);
    let results = await this.driver.extract<AmazonResult[]>(this.tabId!, "amazon.results");
    if (results.length < 3) {
      await this.driver.waitFor(this.tabId!, "loaded", 5000);
      results = await this.driver.extract<AmazonResult[]>(this.tabId!, "amazon.results");
    }
    return results.length ? ok(results) : err("parse_failed", "no result cards found");
  }

  /**
   * C1b: call when the shortlist is final, while it's being read aloud. Opens each product page in a background
   * tab and runs Moss over it, so a later open(asin) is a tab switch and Add to Cart picks from already-embedded
   * text. Page loads run in parallel; embedding runs one page at a time (CPU-bound, and pages share most text).
   * Resolves when every page is ready; callers don't need to await it.
   */
  preload(asins: string[]) {
    for (const asin of asins) {
      if (!this.preloaded.has(asin)) this.preloaded.set(asin, this.preloadOne(asin).catch(() => undefined));
    }
    return Promise.all(asins.map((a) => this.preloaded.get(a)));
  }

  private async preloadOne(asin: string): Promise<number | undefined> {
    const t = await this.driver.openTab("about:blank", { background: true });
    if (!t.ok) return undefined;
    const tabId = t.data.tabId;
    const r = await this.driver.navigate(tabId, `https://www.amazon.com/dp/${asin}`, "commit");
    if (!r.ok) return tabId;
    await this.driver.waitFor(tabId, "amazon.loadedOrChallenge", 10_000);
    const s = await this.driver.snapshot(tabId);
    const moss = this.pickers.find((p) => p.name === "moss");
    // A bot check is left for open() + step() to surface to the user, in the foreground.
    if (s.ok && moss) {
      const run = this.indexing.then(() => moss.pick(s.data, STEPS.addToCart));
      this.indexing = run.catch(() => {});
      await run;
    }
    return tabId;
  }

  /** Closes preloaded tabs that weren't opened. */
  async dropPreloads() {
    const tabs = await Promise.all(this.preloaded.values());
    this.preloaded.clear();
    for (const tabId of tabs) if (tabId !== undefined && tabId !== this.tabId) await this.driver.closeTab(tabId);
  }

  async open(asin: string): Promise<Result<{ url: string }>> {
    this.marks = {};
    const pre = this.preloaded.get(asin);
    if (pre) {
      const t0 = performance.now();
      const tabId = await pre;
      this.preloaded.delete(asin);
      this.mark("preload wait", t0);
      if (tabId !== undefined) {
        this.tabId = tabId;
        return ok({ url: `https://www.amazon.com/dp/${asin}` });
      }
    }
    return this.goto(`https://www.amazon.com/dp/${asin}`);
  }

  async addToCart() {
    this.marks = {};
    const before = await this.driver.extract<string>(this.tabId!, "href");
    const r = await this.step(STEPS.addToCart);
    if (!r.ok) return r;
    const t0 = performance.now();
    await this.driver.waitFor(this.tabId!, "amazon.added", 5000, before);
    this.mark("wait confirmation", t0);
    // Decline the warranty upsell if shown. Deterministic: exact "No Thanks".
    if (await this.driver.extract<boolean>(this.tabId!, "amazon.warranty").catch(() => false)) {
      await sleep(300); // the pane animates in
      const s = await this.driver.snapshot(this.tabId!);
      const no = s.ok ? s.data.elements.find((e) => /^no,? thanks$/i.test(e.name)) : undefined;
      if (no) await this.driver.act(this.tabId!, { kind: "click", idx: no.idx });
    }
    return r;
  }

  /**
   * C2: up to `target` retailer reviews, in a background tab so the product tab stays put for Add to Cart.
   * The full review pages need a signed-in profile; signed out, Amazon redirects to /ap/signin. We don't work
   * around that: we fall back to the ~8 "Top reviews" on the product page and report gated: true.
   */
  async reviews(asin: string, target = 30, maxPages = 6): Promise<Result<ReviewsResult>> {
    const t = await this.driver.openTab("about:blank", { background: true });
    if (!t.ok) return t;
    const tab = t.data.tabId;
    try {
      const t0 = performance.now();
      const r = await this.driver.navigate(tab, `https://www.amazon.com/product-reviews/${asin}/?reviewerType=all_reviews`, "commit");
      if (!r.ok) return r;
      await this.driver.waitFor(tab, "amazon.reviewsReady", 10_000);
      this.mark("reviews first page", t0);
      const g = await this.blockedGate(tab);
      if (!g.ok) return g;
      const gated = await this.driver.extract<boolean>(tab, "amazon.signin");
      if (gated) return await this.productPageReviews(tab, asin);

      let scraped = await this.driver.extract<ScrapedReview[]>(tab, "amazon.reviews");
      let pages = 1;
      while (toRawReviews(asin, scraped).length < target && pages < maxPages) {
        const t1 = performance.now();
        const before = scraped.length;
        // Newer layout: "Show 10 more reviews" appends in place. A plain button, never purchase-risk.
        if (await this.driver.extract<boolean>(tab, "amazon.hasShowMore")) {
          // Its click handler is bound late: clicking while the page is still loading does nothing. Retry once.
          await this.driver.waitFor(tab, "complete", 5000);
          for (let i = 0; i < 2; i++) {
            await this.driver.extract(tab, "amazon.clickShowMore");
            if (await this.driver.waitFor(tab, "amazon.reviewsGrew", i ? 6000 : 3000, before)) break;
          }
          scraped = await this.driver.extract<ScrapedReview[]>(tab, "amazon.reviews");
        } else {
          // Older layout: numbered pages.
          const next = await this.driver.extract<string | null>(tab, "amazon.nextPage");
          if (!next) break;
          const n = await this.driver.navigate(tab, next, "commit");
          if (!n.ok) break;
          await this.driver.waitFor(tab, "amazon.reviewsReady", 10_000);
          scraped = scraped.concat(await this.driver.extract<ScrapedReview[]>(tab, "amazon.reviews"));
        }
        this.mark("reviews more", t1);
        const g2 = await this.blockedGate(tab);
        if (!g2.ok) return g2;
        pages++;
        if (scraped.length <= before) break;
      }
      const reviews = toRawReviews(asin, scraped);
      return reviews.length ? ok({ reviews, pages, via: "reviews_page", gated: false }) : await this.productPageReviews(tab, asin);
    } catch (e) {
      return err("internal", `reviews failed: ${(e as Error).message}`, true);
    } finally {
      await this.driver.closeTab(tab);
    }
  }

  private async productPageReviews(tab: number, asin: string): Promise<Result<ReviewsResult>> {
    try {
      const t0 = performance.now();
      const gated = await this.driver.extract<boolean>(tab, "amazon.signin").catch(() => false);
      const r = await this.driver.navigate(tab, `https://www.amazon.com/dp/${asin}`, "commit");
      if (!r.ok) return r;
      await this.driver.waitFor(tab, "amazon.productReviewsReady", 10_000);
      const g = await this.blockedGate(tab);
      if (!g.ok) return g;
      const reviews = toRawReviews(asin, await this.driver.extract<ScrapedReview[]>(tab, "amazon.reviews"));
      this.mark("reviews product page", t0);
      return ok({ reviews, pages: 1, via: "product_page", gated });
    } catch (e) {
      return err("internal", `product reviews failed: ${(e as Error).message}`, true);
    }
  }

  /**
   * Navigator.getDetail for Amazon. Opens the product (a tab switch if preloaded) and scrapes reviews in parallel.
   * C3: detail fields come from a cached recipe (no AI); Claude writes one only on the first visit or a miss.
   */
  async getDetail(candidate: ProductCandidate, emit: Emit = () => {}): Promise<Result<ProductDetail>> {
    const asin = candidate.id.replace(/^amazon:/, "");
    emit({ stage: "reading_product", message: "Reading the Amazon product page", marketplace: "amazon", at: new Date().toISOString() });
    const reviewsP = this.reviews(asin);
    try {
      const opened = await this.open(asin);
      if (!opened.ok) return opened;
      await this.driver.waitFor(this.tabId!, "amazon.loadedOrChallenge", 10_000);
      const g = await this.blockedGate();
      if (!g.ok) return g;
      const tab = this.tabId!;
      const x = await extractWithRecipes("amazon:product", `https://www.amazon.com/dp/${asin}`, (name, arg) => this.driver.extract(tab, name, arg), this.recipes.cache, this.recipes.writer, AMAZON_PRODUCT_SEED);
      this.lastExtract = { via: x.via, claudeCalls: x.claudeCalls, ms: x.ms };
      this.marks["recipe"] = x.ms;
      console.log(`[recipe] amazon:product via ${x.via}: ${x.claudeCalls} Claude call(s), ${x.ms} ms`);
      const f = x.raw ? amazonFields(x.raw) : undefined;
      const d = f?.bullets.length || f?.description ? { bullets: f.bullets, description: f.description ?? "" } : await this.driver.extract<{ bullets: string[]; description: string }>(tab, "amazon.detail");
      emit({ stage: "reviews", message: "Reading Amazon reviews", marketplace: "amazon", at: new Date().toISOString() });
      const rv = await reviewsP;
      return ok({
        ...candidate,
        title: f?.title || candidate.title,
        brand: f?.brand ?? candidate.brand,
        price: f?.price ?? candidate.price,
        listPrice: f?.listPrice ?? candidate.listPrice,
        deal: f?.deal ?? candidate.deal,
        rating: f?.rating ?? candidate.rating,
        reviewCount: f?.reviewCount ?? candidate.reviewCount,
        imageUrls: f?.imageUrls.length ? f.imageUrls : candidate.imageUrls,
        shipping: f?.shipping ?? candidate.shipping,
        inStock: f?.inStock ?? candidate.inStock,
        source: x.raw ? { via: x.via === "claude" ? "claude" : "recipe", confidence: 0.9, fetchedAt: new Date().toISOString() } : candidate.source,
        description: d.description || d.bullets.join(" ") || candidate.title,
        bullets: d.bullets,
        specs: f?.specs ?? {},
        banners: f?.banners ?? [],
        variants: f?.variants ?? [],
        retailerReviews: rv.ok ? rv.data.reviews : [],
      });
    } catch (e) {
      return err("internal", `getDetail failed: ${(e as Error).message}`, true);
    } finally {
      await reviewsP.catch(() => undefined);
    }
  }

  /** Goes to the cart and reads the subtotal. Never proceeds to checkout's final button. */
  async viewCart(): Promise<Result<{ subtotal: string }>> {
    this.marks = {};
    const g = await this.goto("https://www.amazon.com/gp/cart/view.html");
    if (!g.ok) return g;
    const t0 = performance.now();
    await this.driver.waitFor(this.tabId!, "amazon.subtotalReady", 8000);
    this.mark("wait subtotal", t0);
    // The user presses the final button themselves, so the cart comes to the front.
    await this.driver.focus(this.tabId!);
    return ok({ subtotal: await this.driver.extract<string>(this.tabId!, "amazon.subtotal") });
  }
}
