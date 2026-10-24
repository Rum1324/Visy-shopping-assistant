/**
 * Real Amazon search/cart behind Services.navigator.
 * Target and Walmart stay on fixtures until those flows exist.
 * Set NAV=amazon. A bot check is handed to the human; we never solve it.
 *
 * Called from apps/server/src/ws.ts start() when NAV=amazon.
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
import { buildChain } from "./navigator/chain.ts";
import { PlaywrightDriver } from "./navigator/driver/playwright.ts";
import { AmazonFlow } from "./navigator/sites/amazon.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseDollars(price: string | null | undefined): number | undefined {
  if (!price) return;
  const match = price.replace(/,/g, "").match(/(\d+)(?:\.(\d{1,2}))?/);
  if (!match) return;
  const frac = (match[2] ?? "").padEnd(2, "0").slice(0, 2);
  return Number(match[1]) * 100 + Number(frac);
}

function ratingOf(text: string | null): number | undefined {
  const match = text?.match(/(\d+(?:\.\d+)?)/);
  if (!match) return;
  const n = Number(match[1]);
  return n >= 0 && n <= 5 ? n : undefined;
}

export function liveServices(): Services {
  const mocks = mockNavigator({ latencyMs: 0 });
  const driver = new PlaywrightDriver();
  const chain = buildChain();
  let flow: AmazonFlow;
  let announce: (message: string) => void = (message) => console.log(message);
  flow = new AmazonFlow(driver, chain.pickers, chain.memory, async () => {
    announce("Amazon is showing a bot check. Solve it in the browser window. I will not bypass it.");
    const end = Date.now() + 90_000;
    while (Date.now() < end && flow.tabId != null) {
      if (!(await driver.isBlocked(flow.tabId))) return;
      await sleep(2000);
    }
  });
  const seen = new Map<string, Candidate>();
  let lastAdded: Candidate | undefined;

  const navigator: Navigator = {
    async search(need, marketplace, emit) {
      announce = (message) => emit({ stage: "searching", marketplace, message, at: new Date().toISOString() });
      if (marketplace !== "amazon") return mocks.search(need, marketplace, emit);
      emit({ stage: "searching", marketplace: "amazon", message: "Searching Amazon now", at: new Date().toISOString() });
      const found = await flow.search(need.query);
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
          title: row.title,
          price: { cents, currency: "USD" },
          rating: ratingOf(row.rating),
          inStock: true,
          source: { via: "recipe", confidence: 0.9, fetchedAt: new Date().toISOString() },
        });
        seen.set(candidate.id, candidate);
        candidates.push(candidate);
        if (candidates.length >= 6) break;
      }
      return candidates.length ? ok(candidates) : err("parse_failed", "Amazon results had no priced organic products");
    },

    async getDetail(candidate, emit) {
      if (!candidate.id.startsWith("amazon:")) return mocks.getDetail(candidate, emit);
      emit({ stage: "reading_product", marketplace: "amazon", message: "Reading the Amazon product page", at: new Date().toISOString() });
      const asin = candidate.id.slice("amazon:".length);
      const opened = await flow.open(asin);
      if (!opened.ok) return opened;
      let title = candidate.title;
      let cents = candidate.price.cents;
      if (flow.tabId != null) {
        const page = await driver
          .evaluate<{ title: string; price: string | null }>(
            flow.tabId,
            `({ title: (document.querySelector("#productTitle")?.innerText || "").trim(), price: document.querySelector(".a-price .a-offscreen")?.textContent?.trim() || null })`,
          )
          .catch(() => ({ title: "", price: null }));
        if (page.title) title = page.title;
        const parsed = parseDollars(page.price);
        if (parsed != null) cents = parsed;
      }
      const detail = ProductDetail.parse({
        ...candidate,
        title,
        price: { cents, currency: "USD" },
        description: title,
      });
      seen.set(detail.id, detail);
      return ok(detail);
    },

    async addToCart(id, quantity, emit) {
      if (!id.startsWith("amazon:")) return mocks.addToCart(id, quantity, emit);
      const product = seen.get(id);
      if (!product) return err("not_found", `No Amazon product ${id}`);
      emit({ stage: "carting", marketplace: "amazon", message: "Adding it to your Amazon cart", at: new Date().toISOString() });
      if (!flow.tabId) {
        const opened = await flow.open(id.slice("amazon:".length));
        if (!opened.ok) return opened;
      }
      const added = await flow.addToCart();
      if (!added.ok) return added;
      lastAdded = product;
      return ok({ productId: id, title: product.title, quantity: 1, price: product.price });
    },

    async openCheckout(marketplace, emit) {
      if (marketplace !== "amazon") return mocks.openCheckout(marketplace, emit);
      emit({ stage: "checkout", marketplace: "amazon", message: "Opening your Amazon cart", at: new Date().toISOString() });
      const cart = await flow.viewCart();
      if (!cart.ok) return cart;
      const cents = parseDollars(cart.data.subtotal);
      if (cents == null) return err("parse_failed", "Amazon cart subtotal was not on the page");
      const line = lastAdded ?? [...seen.values()][0];
      return ok({
        marketplace: "amazon" as Marketplace,
        url: "https://www.amazon.com/gp/cart/view.html",
        lines: line ? [{ productId: line.id, title: line.title, quantity: 1, price: line.price }] : [],
        subtotal: { cents, currency: "USD" as const },
        total: { cents, currency: "USD" as const },
        readBack: `Amazon cart subtotal is $${(cents / 100).toFixed(2)}, before tax. I stopped on the cart page.`,
      });
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
