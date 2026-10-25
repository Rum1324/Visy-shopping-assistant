/**
 * Real Amazon search/cart behind Services.navigator.
 * Target and Walmart are live too (navigator/sites/target.ts, navigator/sites/walmart.ts): search and detail,
 * and Target add to cart + cart read-back.
 * Set NAV=amazon. A bot check is handed to the human; we never solve it.
 *
 * Called from apps/server/src/ws.ts start() when NAV=amazon. `driver()` returns the connected extension's
 * driver, so the flow runs in the user's own signed-in Chrome. With no extension connected (or DRIVER=playwright)
 * it falls back to a separate Playwright Chrome.
 */
import {
  err,
  ok,
  productId,
  ProductCandidate,
  ProductDetail,
  type Marketplace,
  type Navigator,
  type ProductCandidate as Candidate,
  type Result,
  type Services,
} from "@visy/contracts";
import {
  consoleVoice,
  mockNavigator,
  mockPreferenceStore,
  mockReviewIndex,
  mockReviewService,
  mockVisionService,
} from "@visy/contracts/mocks";
import { cleanListingTitle } from "./present.ts";
import { buildChain } from "./navigator/chain.ts";
import type { FlowDriver } from "./navigator/driver/flow.ts";
import { PlaywrightDriver } from "./navigator/driver/playwright.ts";
import { AmazonFlow } from "./navigator/sites/amazon.ts";
import { TargetFlow } from "./navigator/sites/target.ts";
import { WalmartFlow } from "./navigator/sites/walmart.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A driver call can throw (tab closed, extension reloaded mid-call). Turn it into an error the agent can say. */
const safe = <T>(p: Promise<Result<T>>): Promise<Result<T>> =>
  p.catch((e) => err("internal", `Amazon flow failed: ${e instanceof Error ? e.message : e}`, true));

const POOL_PER_MARKET = Number(process.env.VISY_POOL_PER_MARKET ?? 30);

export function parseDollars(price: string | null | undefined): number | undefined {
  if (!price) return;
  const match = price.replace(/,/g, "").match(/(\d+)(?:\.(\d{1,2}))?/);
  if (!match) return;
  const frac = (match[2] ?? "").padEnd(2, "0").slice(0, 2);
  return Number(match[1]) * 100 + Number(frac);
}

/** "12,345 ratings", "(1.2K)", "3" → count. */
export function countOf(text: string | null | undefined): number | undefined {
  const match = text?.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([KM])?/i);
  if (!match) return;
  const mult = match[2]?.toUpperCase() === "M" ? 1e6 : match[2] ? 1e3 : 1;
  return Math.round(Number(match[1]) * mult);
}

function ratingOf(text: string | null): number | undefined {
  const match = text?.match(/(\d+(?:\.\d+)?)/);
  if (!match) return;
  const n = Number(match[1]);
  return n >= 0 && n <= 5 ? n : undefined;
}

/** UX-SALES: only what the card shows. A strike price at or below the current price is not a sale. */
export function saleOf(row: { listPrice?: string | null; deal?: string | null }, cents: number) {
  const list = parseDollars(row.listPrice);
  return {
    ...(list != null && list > cents ? { listPrice: { cents: list, currency: "USD" as const } } : {}),
    ...(row.deal ? { deal: { label: row.deal, requiresMembership: /prime/i.test(row.deal) ? "Prime" : undefined } } : {}),
  };
}

export function liveServices(opts: { driver?: () => FlowDriver | undefined } = {}): Services {
  const mocks = mockNavigator({ latencyMs: 0 });
  const chain = buildChain();
  let playwright: PlaywrightDriver | undefined;
  let current: { driver: FlowDriver; flow: AmazonFlow } | undefined;
  let announce: (message: string) => void = (message) => console.log(message);
  /** One AmazonFlow per driver: a new extension connection starts with fresh tabs. */
  const use = () => {
    const ext = process.env.DRIVER === "playwright" ? undefined : opts.driver?.();
    const driver = ext ?? (playwright ??= new PlaywrightDriver());
    if (current?.driver === driver) return current;
    console.log(ext ? "[nav] driving your Chrome through the Visy extension" : "[nav] no extension connected: using a Playwright Chrome");
    const flow: AmazonFlow = new AmazonFlow(driver, chain.pickers, chain.memory, async () => {
      announce("Amazon is showing a bot check. Solve it in the browser tab I just brought up. I will not bypass it.");
      const end = Date.now() + 90_000;
      while (Date.now() < end && flow.tabId != null) {
        if (!(await driver.isBlocked(flow.tabId))) return;
        await sleep(2000);
      }
    });
    current = { driver, flow };
    return current;
  };
  const seen = new Map<string, Candidate>();
  let lastAdded: Candidate | undefined;
  // C-TGT: live Target search + detail on the same driver, in its own tab. C-TGT-CART: add to cart + cart read-back too.
  const targets = new WeakMap<FlowDriver, TargetFlow>();
  const target = () => {
    const { driver } = use();
    if (!targets.has(driver)) targets.set(driver, new TargetFlow(driver, (m) => announce(m), undefined, chain));
    return targets.get(driver)!;
  };
  // C-WMT: Walmart search + detail on the same driver as Amazon, in its own background tabs.
  let walmart: { driver: FlowDriver; flow: WalmartFlow } | undefined;
  const useWalmart = () => {
    const { driver } = use();
    if (walmart?.driver !== driver) walmart = { driver, flow: new WalmartFlow(driver) };
    return walmart.flow;
  };

  const navigator: Navigator = {
    async search(need, marketplace, emit) {
      if (marketplace === "walmart") {
        const found = await safe(useWalmart().search(need.query, emit, POOL_PER_MARKET));
        if (found.ok) for (const c of found.data) seen.set(c.id, c);
        return found;
      }
      announce = (message) => emit({ stage: "searching", marketplace, message, at: new Date().toISOString() });
      if (marketplace === "target") return safe(target().search(need.query, emit, POOL_PER_MARKET));
      if (marketplace !== "amazon") {
        // Any other marketplace is sample listings (picnic blankets). Only offer them when they match the search,
        // so "power bank" doesn't come back with blankets.
        const sample = await mocks.search(need, marketplace, emit);
        const words = need.query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        return sample.ok ? ok(sample.data.filter((c) => words.some((w) => c.title.toLowerCase().includes(w)))) : sample;
      }
      emit({ stage: "searching", marketplace: "amazon", message: "Searching Amazon now", at: new Date().toISOString() });
      const { flow } = use();
      const found = await safe(flow.search(need.query));
      if (!found.ok) return found;
      const candidates: Candidate[] = [];
      for (const row of found.data) {
        if (row.sponsored) continue;
        const cents = parseDollars(row.price);
        if (cents == null) continue;
        const candidate = ProductCandidate.parse({
          id: productId("amazon", row.asin),
          marketplace: "amazon",
          url: `https://www.amazon.com/dp/${row.asin}`,
          title: cleanListingTitle(row.title),
          price: { cents, currency: "USD" },
          ...saleOf(row, cents),
          rating: ratingOf(row.rating),
          reviewCount: countOf(row.reviews),
          inStock: true,
          source: { via: "recipe", confidence: 0.9, fetchedAt: new Date().toISOString() },
        });
        seen.set(candidate.id, candidate);
        candidates.push(candidate);
        // The whole pool goes to narrowing (narrow.ts); only the final 3 get opened.
        if (candidates.length >= POOL_PER_MARKET) break;
      }
      const sponsored = found.data.filter((r) => r.sponsored).length;
      console.log(`amazon search: ${found.data.length} cards, ${sponsored} sponsored → ${candidates.length} candidates`);
      return candidates.length ? ok(candidates) : err("parse_failed", "Amazon results had no priced organic products");
    },

    async getDetail(candidate, emit) {
      if (candidate.id.startsWith("target:")) return safe(target().getDetail(candidate, emit));
      if (candidate.id.startsWith("walmart:")) return safe(useWalmart().getDetail(candidate, emit));
      if (!candidate.id.startsWith("amazon:")) return mocks.getDetail(candidate, emit);
      // C2 + C3: opens the product, reads details via a cached recipe and scrapes retailer reviews in parallel.
      const { flow, driver } = use();
      const asin = candidate.id.slice("amazon:".length);
      const base = await safe(flow.getDetail(candidate, emit));
      if (!base.ok) return base;
      let title = cleanListingTitle(base.data.title);
      let cents = base.data.price.cents;
      // C3's recipe already read title and price; this is only the no-recipe fallback.
      const tab = flow.productTabs.get(asin) ?? flow.tabId;
      if (tab != null && flow.extracts.get(asin)?.via === "none") {
        const page = await driver
          .extract<{ title: string; price: string | null }>(tab, "amazon.titlePrice")
          .catch(() => ({ title: "", price: null }));
        if (page.title) title = cleanListingTitle(page.title);
        const parsed = parseDollars(page.price);
        if (parsed != null) cents = parsed;
      }
      const detail = ProductDetail.parse({
        ...base.data,
        title,
        price: { cents, currency: "USD" },
        description: base.data.description || title,
      });
      seen.set(detail.id, detail);
      return ok(detail);
    },

    async addToCart(id, quantity, emit) {
      if (id.startsWith("target:")) return safe(target().addToCart(id, emit));
      if (!id.startsWith("amazon:")) return mocks.addToCart(id, quantity, emit);
      const product = seen.get(id);
      if (!product) return err("not_found", `No Amazon product ${id}`);
      emit({ stage: "carting", marketplace: "amazon", message: "Adding it to your Amazon cart", at: new Date().toISOString() });
      const { flow } = use();
      // Always switch to this product's tab: with 3 option tabs open, the current tab may be another option.
      const opened = await safe(flow.open(id.slice("amazon:".length)));
      if (!opened.ok) return opened;
      const added = await safe(flow.addToCart());
      if (!added.ok) return added;
      lastAdded = product;
      return ok({ productId: id, title: product.title, quantity: 1, price: product.price });
    },

    async openCheckout(marketplace, emit) {
      if (marketplace === "target") return safe(target().checkout(emit));
      if (marketplace !== "amazon") return mocks.openCheckout(marketplace, emit);
      emit({ stage: "checkout", marketplace: "amazon", message: "Opening your Amazon cart", at: new Date().toISOString() });
      const { flow } = use();
      const cart = await safe(flow.viewCart());
      if (!cart.ok) return cart;
      const cents = parseDollars(cart.data.subtotal);
      if (cents == null) return err("parse_failed", "Amazon cart subtotal was not on the page");
      const line = lastAdded ?? [...seen.values()][0];
      const lines = line ? [{ productId: line.id, title: line.title, quantity: 1, price: line.price }] : [];
      const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
      // B-READBACK: go one step further to the order review page for the total with tax. Never press its final button.
      emit({ stage: "checkout", marketplace: "amazon", message: "Opening checkout", at: new Date().toISOString() });
      const order = await safe(flow.reviewOrder());
      if (!order.ok) console.warn("checkout review failed, reading the cart instead:", order.error.message);
      const o = order.ok ? order.data : undefined;
      // Say the button that is really on the screen ("Place your order in JPY" when Amazon's converter is on).
      const button = o?.button ?? "Proceed to checkout";
      const usdCents = parseDollars(o?.usd);
      if (o?.total && usdCents != null) {
        const charged = /^\$/.test(o.total) ? "" : `, charged as ${o.total}`;
        const tax = /^\$/.test(o.tax ?? "") ? parseDollars(o.tax) : undefined;
        return ok({
          marketplace: "amazon" as Marketplace,
          url: o.url,
          lines,
          subtotal: { cents, currency: "USD" as const },
          ...(tax != null ? { tax: { cents: tax, currency: "USD" as const } } : {}),
          total: { cents: usdCents, currency: "USD" as const },
          readBack: `Your Amazon total is ${usd(usdCents)}${tax != null ? `, including ${usd(tax)} tax` : " with tax"}${charged}. Press ${button} when you're ready.`,
        });
      }
      if (o && !o.total) console.warn(`checkout review: no order total on ${o.url}`);
      return ok({
        marketplace: "amazon" as Marketplace,
        url: o?.url ?? "https://www.amazon.com/gp/cart/view.html",
        lines,
        subtotal: { cents, currency: "USD" as const },
        total: { cents, currency: "USD" as const },
        readBack: o?.total
          ? `Your Amazon total is ${o.total} with tax. Press ${button} when you're ready.`
          : `Your Amazon cart subtotal is ${usd(cents)} before tax. Press ${button} when you're ready.`,
      });
    },

    async openOptions(ids, emit) {
      const asins = ids.filter((id) => id.startsWith("amazon:")).map((id) => id.slice("amazon:".length));
      if (!asins.length) return;
      emit({ stage: "reading_product", marketplace: "amazon", message: "Opening the options in tabs", at: new Date().toISOString() });
      await safe(use().flow.showOptions(asins).then(() => ok({}))).catch(() => {});
    },
  };

  return {
    navigator,
    reviews: mockReviewService({ latencyMs: 0 }),
    vision: mockVisionService({ latencyMs: 0 }),
    reviewIndex: mockReviewIndex(),
    prefs: mockPreferenceStore(),
    voice: consoleVoice(),
  };
}
