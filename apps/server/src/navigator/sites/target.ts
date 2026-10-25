import {
  CheckoutReview,
  err,
  ok,
  productId,
  ProductCandidate,
  RawReview,
  type CartLine,
  type ElementPicker,
  type Emit,
  type PageElement,
  type ProductDetail,
  type Result,
} from "@visy/contracts";
import type { FlowDriver } from "../driver/flow.ts";
import { pickWithChain, type ChainPick } from "../chain.ts";
import type { FindStep } from "../pickers/common.ts";
import type { MemoryPicker } from "../pickers/memory.ts";
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
// The ~8 newest reviews ship in the page's Next.js JSON (product.ratings_and_reviews.most_recent), so they're readable
// in a background tab, where the review cards never render (they lazy-load on scroll). arg = the tcin to match.
const NEXT_REVIEWS_JS = `(() => {
  let d; try { d = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null'); } catch { return []; }
  const hits = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 16 || hits.length > 4) return;
    if (o.ratings_and_reviews && Array.isArray(o.ratings_and_reviews.most_recent)) hits.push(o);
    for (const k in o) walk(o[k], depth + 1);
  };
  walk(d, 0);
  const p = hits.find((h) => String(h.tcin) === String(arg)) || hits[0];
  return (p ? p.ratings_and_reviews.most_recent : []).map((r) => ({ id: String(r.id || ''), title: r.title || '', body: r.text || '', date: r.rating?.submitted_at || '', author: r.author?.nickname || null, rating: r.rating?.value ?? null, verified: null, syndicated: false })).filter((r) => r.body);
})()`;
// Same JSON, product.item: title, brand, highlights, description, images, specs. No price: Target fetches that
// client-side and renders it only when visible, so a background tab may never show one. arg = the tcin to match.
const NEXT_ITEM_JS = `(() => {
  let d; try { d = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null'); } catch { return null; }
  const hits = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 18 || hits.length > 4) return;
    if (o.tcin && o.item && o.item.product_description) hits.push(o);
    for (const k in o) walk(o[k], depth + 1);
  };
  walk(d, 0);
  const p = hits.find((h) => String(h.tcin) === String(arg)) || hits[0];
  if (!p) return null;
  const it = p.item, pd = it.product_description || {}, ii = (it.enrichment || {}).image_info || {};
  const strip = (s) => String(s || '').replace(/<br\\s*\\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&#(\\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\\s+/g, ' ').trim();
  return {
    title: strip(pd.title) || null,
    brand: (it.primary_brand || {}).name || null,
    bullets: ((pd.soft_bullets || {}).bullets || []).map(strip).filter(Boolean).slice(0, 12),
    description: strip(pd.downstream_description).slice(0, 3000) || null,
    images: [ii.primary_image].concat(ii.alternate_images || []).map((i) => i && i.url).filter(Boolean).slice(0, 8),
    specs: (pd.bullet_descriptions || []).map((b) => strip(b).split(/:\\s*/)).filter((kv) => kv.length > 1 && kv[1]).map((kv) => [kv[0], kv.slice(1).join(': ')]).slice(0, 40),
  };
})()`;

// C-TGT-CART, checked by hand on live target.com 2026-10-24. The header cart link reads "cart 0 items" / "cart 1 item".
const CART_COUNT_JS = `Number((/(\\d+)/.exec(document.querySelector('[data-test="@web/CartLink"]')?.getAttribute('aria-label') || '') || [])[1] || 0)`;
// Cart page summary: "Subtotal (1 item)$20.00", "Shipping$5.99", "Estimated taxes$2.05", "Est. total$28.04". The
// button is "Check out", or "Sign in to check out" for a guest cart. We only read it: the user presses it.
const CART_JS = String.raw`(() => {
  const t = (s) => (document.querySelector('[data-test="' + s + '"]')?.innerText || '').replace(/\s+/g, ' ').trim();
  const amt = (s) => (/\$[\d,]+(?:\.\d{2})?/.exec(t(s)) || [])[0] || null;
  const items = Array.from(document.querySelectorAll('[data-test="cartItem"]')).map((c) => ({
    tcin: (/\/A-(\d+)/.exec(c.querySelector('a[href*="/A-"]')?.getAttribute('href') || '') || [])[1] || null,
    title: (c.querySelector('[data-test="cartItem-title"]')?.innerText || '').replace(/\s+/g, ' ').trim(),
    price: (c.querySelector('[data-test="cartItem-price"]')?.innerText || '').replace(/\s+/g, ' ').trim(),
    qty: Number(c.querySelector('[data-test="cartItem-qty-stepper"] select')?.value) || 1,
  })).filter((i) => i.tcin && i.title);
  const button = (document.querySelector('[data-test="checkout-button"]')?.innerText || '').replace(/\s+/g, ' ').trim() || null;
  return { subtotal: amt('cart-summary-subTotal'), shipping: t('cart-summary-fulfillment') || null, tax: amt('cart-summary-taxes'), total: amt('cart-summary-total'), items, button, empty: !!document.querySelector('[data-test="boxEmptyMsg"]'), url: location.href };
})()`;

/** Named page scripts (navigator/scripts.ts); the extension runs them by name. Whatever they return is UNTRUSTED. */
export const TARGET_SCRIPTS = {
  "target.results": RESULTS_JS,
  // JS-rendered: the HTML arrives with no cards. Ready = one titled card, the "no results" block, or a bot check.
  "target.resultsReady": `!!document.querySelector('${CARD_SEL} h3') || !!document.querySelector('[data-test="nlr-container"]') || ${CHALLENGE_JS}`,
  // The first page has ~24-30 cards; they stream in after the first one.
  "target.cardsReady": `document.querySelectorAll('${CARD_SEL} h3').length >= 20`,
  // The title and the page JSON are server-rendered; price, rating and delivery render later (only when visible).
  "target.detailReady": `!!document.getElementById('__NEXT_DATA__') || !!document.querySelector('[data-test="product-title"]') || ${CHALLENGE_JS}`,
  "target.priceReady": `!!document.querySelector('[data-test="product-price"]') || ${CHALLENGE_JS}`,
  "target.fulfillment": FULFILLMENT_JS,
  "target.nextItem": NEXT_ITEM_JS,
  "target.nextReviews": NEXT_REVIEWS_JS,
  // Fallback: review cards load when their section scrolls into view (foreground tab only). Scrolling only, never a click.
  "target.scrollReviews": `void document.querySelector('[data-test="ReviewsDashboard"], [data-test="reviews-heading"]')?.scrollIntoView()`,
  "target.reviewsReady": `!!document.querySelector('[data-test="review-card--text"]')`,
  "target.reviews": REVIEWS_JS,
  // C-TGT-CART. The buy box draws only in a visible tab, first as a skeleton ("shipping - loading...", a dead
  // Add to cart button), then the real Pickup / Delivery / Shipping tiles.
  "target.buyBoxReady": `(() => { const t = Array.from(document.querySelectorAll('#SHIPPING, #PICKUP, #DELIVERY')); return t.length > 0 && t.every((b) => !/loading/i.test(b.getAttribute('aria-label') || '')); })() || ${CHALLENGE_JS}`,
  "target.addReady": `Array.from(document.querySelectorAll('button')).some((b) => /^add to cart$/i.test((b.textContent || '').trim()) && !b.disabled)`,
  "target.shippingSelected": `/selected/i.test(document.getElementById('SHIPPING')?.getAttribute('aria-label') || '')`,
  "target.cartCount": CART_COUNT_JS,
  // arg = the cart count before the click. Target opens an "Added to cart" dialog and bumps the header count.
  "target.added": `${CART_COUNT_JS} > Number(arg) || Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).some((d) => /^\\s*Added to cart/i.test(d.innerText || ''))`,
  "target.titlePrice": `({ title: (document.querySelector('[data-test="product-title"]')?.textContent || '').trim(), price: (document.querySelector('[data-test="product-price"]')?.textContent || '').trim() || null })`,
  "target.cartReady": `!!document.querySelector('[data-test="cart-summary-subTotal"], [data-test="boxEmptyMsg"]') || ${CHALLENGE_JS}`,
  "target.cartFilled": `!!document.querySelector('[data-test="cart-summary-subTotal"]')`,
  "target.cart": CART_JS,
};

export const TARGET_STEPS = {
  addToCart: { kind: "find_control", intent: "button: Add to cart | section: above-the-fold-information", then: "click" },
} satisfies Record<string, FindStep>;

/** target.cart: the cart page as text (untrusted). Amounts as shown ("$20.00"); shipping is the whole row ("Shipping$5.99", "ShippingFree"). */
export type TargetCart = {
  subtotal: string | null;
  shipping: string | null;
  tax: string | null;
  total: string | null;
  items: { tcin: string; title: string; price: string; qty: number }[];
  button: string | null;
  empty: boolean;
  url: string;
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

/** target.nextItem: the product's server-rendered JSON (untrusted page data). */
export type NextItem = { title: string | null; brand: string | null; bullets: string[]; description: string | null; images: string[]; specs: [string, string][] };

type ScrapedReview = { id?: string; title: string; body: string; date: string; author: string | null; rating: number | null; verified: boolean | null; syndicated: boolean };

/** Page JSON text keeps HTML entities ("70&#34;x80&#34;"). */
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
/** "5 July, 2026" (review card) or "2021-08-05T06:18:14.000Z" (page JSON) → ISO, or undefined. */
export function targetReviewDate(s: string): string | undefined {
  const t = /^\d{4}-\d\d-\d\d/.test(s) ? Date.parse(s) : Date.parse(`${s.replace(/,/g, "")} UTC`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Page JSON reviews carry an id; review cards don't, so theirs hashes author + date + body. Text is untrusted. */
export function toTargetReviews(tcin: string, url: string, scraped: ScrapedReview[]): RawReview[] {
  const out = new Map<string, RawReview>();
  for (const r of scraped) {
    const id = `target:${tcin}:${r.id || hash(`${r.author}|${r.date}|${r.body}`)}`;
    const parsed = RawReview.safeParse({
      id,
      productId: productId("target", `A-${tcin}`),
      source: "retailer",
      url,
      author: r.author ?? undefined,
      rating: r.rating ?? undefined,
      title: r.title ? decode(r.title) : undefined,
      body: decode(r.body).slice(0, 4000),
      date: targetReviewDate(r.date),
      verifiedPurchase: r.verified ?? undefined,
      untrusted: true,
    });
    if (parsed.success) out.set(id, parsed.data);
  }
  return [...out.values()];
}

/** C-TGT-CART: the cart page → the read-back. Target's cart already shows estimated tax and total, so we stop there. */
export function targetCheckout(cart: TargetCart): Result<CheckoutReview> {
  const subtotal = money(cart.subtotal);
  if (!subtotal) return err("parse_failed", cart.empty ? "Target cart is empty" : "Target cart subtotal was not on the page");
  const total = money(cart.total);
  const tax = money(cart.tax);
  const shipping = /free/i.test(cart.shipping ?? "") ? { cents: 0, currency: "USD" as const } : money(cart.shipping);
  const lines = cart.items.flatMap((i) => {
    const price = money(i.price);
    return price ? [{ productId: productId("target", `A-${i.tcin}`), title: i.title, quantity: Math.max(1, i.qty), price }] : [];
  });
  const usd = (m: { cents: number }) => `$${(m.cents / 100).toFixed(2)}`;
  const button = cart.button ?? "Check out";
  const count = cart.items.reduce((n, i) => n + Math.max(1, i.qty), 0);
  const what = count > 1 ? `Your Target cart has ${count} items. ` : "";
  const extras = [tax ? `${usd(tax)} estimated tax` : "", shipping?.cents ? `${usd(shipping)} shipping` : ""].filter(Boolean).join(" and ");
  const readBack = total
    ? `${what}Your Target total is about ${usd(total)}${extras ? `, including ${extras}` : " with tax"}. Press ${button} when you're ready.`
    : `${what}Your Target cart subtotal is ${usd(subtotal)} before tax. Press ${button} when you're ready.`;
  return ok(
    CheckoutReview.parse({
      marketplace: "target",
      url: cart.url,
      lines,
      subtotal,
      ...(shipping ? { shipping } : {}),
      ...(tax ? { tax } : {}),
      total: total ?? subtotal,
      readBack,
    }),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = () => new Date().toISOString();

export class TargetFlow {
  tabId?: number;
  /** Sub-step timings for the last call, like AmazonFlow.marks. */
  marks: Record<string, number> = {};
  /** id → search candidate, so addToCart can name the product and its price (live.ts keeps no Target candidates). */
  private known = new Map<string, ProductCandidate>();

  constructor(
    private driver: FlowDriver,
    private announce: (message: string) => void = (m) => console.log(m),
    private recipes: { cache: RecipeCache; writer: RecipeWriter } = { cache: new RecipeCache(), writer: new ClaudeRecipeWriter() },
    /** The picker chain for Add to cart (live.ts passes buildChain()). Empty → addToCart fails with low_confidence. */
    private chain: { pickers: ElementPicker[]; memory?: MemoryPicker } = { pickers: [] },
  ) {}

  private mark(label: string, t0: number) {
    this.marks[label] = Math.round((this.marks[label] ?? 0) + performance.now() - t0);
  }

  /** A bot check goes to the human: bring the tab up, say so, wait up to 90 s. We never solve it. */
  private async blockedGate(tab = this.tabId!): Promise<Result<{}>> {
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
    for (const c of candidates) this.known.set(c.id, c);
    console.log(`target search: ${rows.length} cards, ${rows.filter((r) => r.sponsored).length} sponsored → ${candidates.length} candidates`, this.marks);
    return candidates.length ? ok(candidates) : err("parse_failed", rows.length ? "Target results had no priced organic products" : "no Target result cards found");
  }

  /**
   * Navigator.getDetail for Target. The page JSON gives title, brand, highlights, description, images, specs and
   * reviews with no rendering. Price, deal, rating and delivery come from the rendered page via the seed recipe when
   * Target has drawn them (a background tab often never does); otherwise the search card's values stand.
   * Claude writes a recipe only if neither the JSON nor the page has a title.
   */
  async getDetail(candidate: ProductCandidate, emit: Emit = () => {}): Promise<Result<ProductDetail>> {
    // The agent reads all three options at once, so each read gets its own background tab, closed afterwards.
    const marks: Record<string, number> = {};
    const mark = (label: string, t0: number) => (marks[label] = Math.round(performance.now() - t0));
    const tcin = candidate.id.replace(/^target:A-/, "");
    emit({ stage: "reading_product", message: "Reading the Target product page", marketplace: "target", at: at() });
    const t = await this.driver.openTab("about:blank", { background: true });
    if (!t.ok) return t;
    const tab = t.data.tabId;
    try {
      return await this.readDetail(candidate, tab, tcin, marks, mark, emit);
    } finally {
      await this.driver.closeTab(tab).catch(() => {});
    }
  }

  private async readDetail(
    candidate: ProductCandidate,
    tab: number,
    tcin: string,
    marks: Record<string, number>,
    mark: (label: string, t0: number) => void,
    emit: Emit,
  ): Promise<Result<ProductDetail>> {
    const t0 = performance.now();
    const g = await this.driver.navigate(tab, candidate.url, "commit");
    if (!g.ok) return g;
    await this.driver.waitFor(tab, "target.detailReady", 10_000);
    mark("wait detail", t0);
    const b = await this.blockedGate(tab);
    if (!b.ok) return b;
    const json = await this.driver.extract<NextItem | null>(tab, "target.nextItem", tcin).catch(() => null);
    const t1 = performance.now();
    await this.driver.waitFor(tab, "target.priceReady", json?.title ? 2500 : 6000);
    mark("wait price", t1);
    const run = <T>(name: "recipe.replay" | "recipe.outline", arg: unknown) => this.driver.extract<T>(tab, name, arg);
    const t2 = performance.now();
    let raw = await run<RawDetail>("recipe.replay", TARGET_PRODUCT_SEED).catch(() => null);
    let via = raw?.price ? "seed" : json?.title ? "json" : "seed";
    if (!raw?.title && !json?.title) {
      console.log(`[recipe] target seed missed on ${candidate.url}`);
      const x = await extractWithRecipes("target:product", candidate.url, run, this.recipes.cache, this.recipes.writer);
      raw = x.raw;
      via = x.via;
    }
    mark("recipe", t2);
    const fulfillment = await this.driver.extract<string[]>(tab, "target.fulfillment").catch(() => []);
    emit({ stage: "reviews", message: "Reading Target reviews", marketplace: "target", at: at() });
    const t3 = performance.now();
    let scraped = await this.driver.extract<ScrapedReview[]>(tab, "target.nextReviews", tcin).catch(() => []);
    if (!scraped.length) {
      await this.driver.extract(tab, "target.scrollReviews").catch(() => {});
      await this.driver.waitFor(tab, "target.reviewsReady", 2500);
      scraped = await this.driver.extract<ScrapedReview[]>(tab, "target.reviews").catch(() => []);
    }
    const reviews = toTargetReviews(tcin, candidate.url, scraped);
    mark("reviews", t3);
    const f = raw ? targetFields(raw, fulfillment) : undefined;
    console.log(`target detail ${candidate.id}: via ${via}, page price ${f?.price ? "yes" : "no (search price)"}, ${reviews.length} reviews`, marks);
    const bullets = f?.bullets.length ? f.bullets : (json?.bullets ?? []);
    return ok({
      ...candidate,
      title: json?.title || f?.title || candidate.title,
      brand: json?.brand?.replace(/[™®]/g, "").trim() || f?.brand || candidate.brand,
      price: f?.price ?? candidate.price,
      listPrice: f?.price ? f.listPrice : candidate.listPrice,
      deal: f?.price ? f.deal : candidate.deal,
      rating: f?.rating ?? candidate.rating,
      reviewCount: f?.reviewCount ?? candidate.reviewCount,
      imageUrls: json?.images.length ? json.images : f?.imageUrls.length ? f.imageUrls : candidate.imageUrls,
      shipping: f?.shipping ?? candidate.shipping,
      inStock: f?.inStock ?? candidate.inStock,
      source: raw || json ? { via: via === "claude" ? "claude" : "recipe", confidence: 0.9, fetchedAt: at() } : candidate.source,
      description: json?.description || f?.description || bullets.join(" ") || candidate.snippet || candidate.title,
      bullets,
      specs: Object.fromEntries((json?.specs ?? []).map(([k, v]) => [k.slice(0, 80), v.slice(0, 300)])),
      banners: f?.banners ?? [],
      variants: [],
      retailerReviews: reviews,
    });
  }

  /**
   * Snapshot → picker chain → click. The chain never returns a purchaseRisk element, and the driver refuses one too.
   * `only` narrows what the chain sees: next to Target's Add to cart sits "Add to List", which Moss trusted (0.92)
   * live when no Add to cart was drawn yet, and memory then replayed it.
   */
  private async step(step: FindStep, only?: (e: PageElement) => boolean, tries = 2): Promise<Result<ChainPick>> {
    for (let attempt = 1; ; attempt++) {
      let t0 = performance.now();
      const s = await this.driver.snapshot(this.tabId!);
      this.mark("snapshot", t0);
      if (!s.ok) {
        if (s.error.code !== "blocked" || attempt >= tries) return s;
        const g = await this.blockedGate();
        if (!g.ok) return g;
        continue;
      }
      const state = only ? { ...s.data, elements: s.data.elements.filter(only) } : s.data;
      if (!state.elements.length) {
        if (attempt >= tries) return err("not_found", `no "${step.intent}" on the page`);
        await sleep(500);
        continue;
      }
      t0 = performance.now();
      const pick = await pickWithChain(this.chain.pickers, state, step, this.chain.memory);
      this.mark("pick", t0);
      if (!pick.ok) {
        if (attempt >= tries) return pick;
        await sleep(500);
        continue;
      }
      t0 = performance.now();
      const r = await this.driver.act(this.tabId!, { kind: "click", idx: pick.data.idx });
      this.mark("act", t0);
      if (!r.ok) return r;
      return ok(pick.data);
    }
  }

  /**
   * Pickup is Target's default, and when the user's store doesn't stock the item the buy box shows "Show in-stock
   * stores" instead of Add to cart. So pick the Shipping tile first. Deterministic: the Fulfillment region's
   * "Shipping …" button, skipped if it's already selected or unavailable.
   */
  private async chooseShipping() {
    const s = await this.driver.snapshot(this.tabId!);
    if (!s.ok) return;
    const tile = s.data.elements.find((e) => e.role === "button" && /^Shipping\b(?!\s*&)/i.test(e.name) && /Fulfillment/.test(e.section ?? ""));
    if (!tile || tile.disabled || /selected$/i.test(tile.name) || /not available|unavailable/i.test(tile.name)) return;
    await this.driver.act(this.tabId!, { kind: "click", idx: tile.idx });
    await this.driver.waitFor(this.tabId!, "target.shippingSelected", 3000);
  }

  private static isAddToCart = (e: PageElement) => e.role === "button" && !e.disabled && /^add to cart\b/i.test(e.name);

  /**
   * C-TGT-CART: opens the product in the flow's tab, in front (Target draws the buy box only in a visible tab, and
   * the user sees what's being added), picks Shipping, then clicks Add to cart through the picker chain.
   * Quantity stays 1, like AmazonFlow.
   */
  async addToCart(id: string, emit: Emit = () => {}): Promise<Result<CartLine>> {
    this.marks = {};
    const tcin = id.replace(/^target:A-/, "");
    const product = this.known.get(id);
    emit({ stage: "carting", marketplace: "target", message: "Adding it to your Target cart", at: at() });
    const g = await this.goto(product?.url ?? `https://www.target.com/p/-/A-${tcin}`);
    if (!g.ok) return g;
    await this.driver.focus(this.tabId!);
    const t0 = performance.now();
    await this.driver.waitFor(this.tabId!, "target.buyBoxReady", 12_000);
    this.mark("wait buy box", t0);
    const b = await this.blockedGate();
    if (!b.ok) return b;
    const before = await this.driver.extract<number>(this.tabId!, "target.cartCount").catch(() => 0);
    await this.chooseShipping();
    await this.driver.waitFor(this.tabId!, "target.addReady", 3000);
    const r = await this.step(TARGET_STEPS.addToCart, TargetFlow.isAddToCart);
    if (!r.ok) {
      // Variant items ("Choose size") and ones Target won't ship to this zip have no Add to cart button.
      return r.error.code === "not_found" ? err("not_found", "Target shows no Add to cart button for this item. It may need a size or color chosen first.") : r;
    }
    const t1 = performance.now();
    const added = await this.driver.waitFor(this.tabId!, "target.added", 6000, before);
    this.mark("wait confirmation", t1);
    console.log(`target add ${id}: ${added ? "added" : "no confirmation"} via ${r.data.picker}`, this.marks);
    if (!added) return err("not_found", "Target did not confirm the item was added to the cart");
    const page = await this.driver.extract<{ title: string; price: string | null }>(this.tabId!, "target.titlePrice").catch(() => ({ title: "", price: null }));
    const price = product?.price ?? money(page.price);
    if (!price) return err("parse_failed", "added to the Target cart, but no price was on the page");
    return ok({ productId: id, title: product?.title || page.title || id, quantity: 1, price });
  }

  /** Goes to target.com/cart, in front, and reads the summary. Never presses the checkout button: the user does. */
  async checkout(emit: Emit = () => {}): Promise<Result<CheckoutReview>> {
    this.marks = {};
    emit({ stage: "checkout", marketplace: "target", message: "Opening your Target cart", at: at() });
    const g = await this.goto("https://www.target.com/cart");
    if (!g.ok) return g;
    await this.driver.focus(this.tabId!);
    const t0 = performance.now();
    await this.driver.waitFor(this.tabId!, "target.cartReady", 10_000);
    const b = await this.blockedGate();
    if (!b.ok) return b;
    let cart = await this.driver.extract<TargetCart>(this.tabId!, "target.cart");
    // The empty-cart box can show before the cart's items load.
    if (!cart.subtotal && (await this.driver.waitFor(this.tabId!, "target.cartFilled", 4000))) {
      cart = await this.driver.extract<TargetCart>(this.tabId!, "target.cart");
    }
    this.mark("wait cart", t0);
    console.log(`target cart: ${cart.items.length} lines, subtotal ${cart.subtotal}, total ${cart.total}`, this.marks);
    return targetCheckout(cart);
  }
}
