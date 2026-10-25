/**
 * Fixture-backed implementations of every service interface. Each one adds a fake delay and emits
 * progress like the real thing would. Replace them one at a time as real implementations land.
 */
import { err, ok, type Emit, type Marketplace, type ProgressEvent } from "./common.ts";
import type { BrowserDriver } from "./driver.ts";
import { fixtures } from "./fixtures.ts";
import type { PreferenceFact, PurchaseRecord, UserProfile } from "./prefs.ts";
import type { ProductDetail, RawReview } from "./product.ts";
import type {
  Navigator,
  PreferenceStore,
  ReviewIndex,
  ReviewService,
  Services,
  VisionService,
  VoiceOut,
} from "./services.ts";

export type MockOptions = { latencyMs?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const NAMES: Record<Marketplace, string> = {
  amazon: "Amazon",
  target: "Target",
  walmart: "Walmart",
  bestbuy: "Best Buy",
  ebay: "eBay",
  other: "the store",
  nearlynatural: "Nearly Natural",
  shopify: "a specialty shop",
};
const progress = (stage: ProgressEvent["stage"], message: string, marketplace?: Marketplace): ProgressEvent => ({
  stage,
  message,
  marketplace,
  at: now(),
});

export function mockNavigator({ latencyMs = 600 }: MockOptions = {}): Navigator {
  return {
    async search(_need, marketplace, emit) {
      emit(progress("searching", `Searching ${NAMES[marketplace]} now`, marketplace));
      await sleep(latencyMs);
      return ok(fixtures.candidates.filter((c) => c.marketplace === marketplace));
    },
    async getDetail(candidate, emit) {
      emit(progress("reading_product", `Reading the ${NAMES[candidate.marketplace]} product page`, candidate.marketplace));
      await sleep(latencyMs);
      const detail: ProductDetail = fixtures.details.find((d) => d.id === candidate.id) ?? {
        ...candidate,
        description: candidate.snippet ?? candidate.title,
        bullets: [],
        specs: {},
        banners: [],
        variants: [],
        retailerReviews: [],
      };
      return ok(detail);
    },
    async addToCart(productId, quantity, emit) {
      const c = fixtures.candidates.find((c) => c.id === productId);
      if (!c) return err("not_found", `No fixture for ${productId}`);
      emit(progress("carting", `Adding it to your ${NAMES[c.marketplace]} cart`, c.marketplace));
      await sleep(latencyMs);
      return ok({ productId, title: c.title, quantity, price: c.price });
    },
    async openCheckout(marketplace, emit) {
      emit(progress("checkout", `Opening ${NAMES[marketplace]} checkout`, marketplace));
      await sleep(latencyMs);
      return ok({ ...fixtures.checkout, marketplace });
    },
  };
}

export function mockReviewService({ latencyMs = 800 }: MockOptions = {}): ReviewService {
  return {
    async collectExternal(product, emit) {
      emit(progress("reviews", "Checking Reddit and YouTube reviews"));
      await sleep(latencyMs);
      return ok(fixtures.externalReviews.filter((r) => r.productId === product.id));
    },
    async synthesize(product) {
      await sleep(latencyMs);
      const s = fixtures.syntheses.find((s) => s.productId === product.id);
      return s ? ok(s) : err("not_found", `No synthesis fixture for ${product.id}`);
    },
  };
}

export function mockVisionService({ latencyMs = 500 }: MockOptions = {}): VisionService {
  return {
    async describe(product) {
      await sleep(latencyMs);
      const v = fixtures.visuals.find((v) => v.productId === product.id);
      return v ? ok(v) : err("not_found", `No visual fixture for ${product.id}`);
    },
  };
}

/** Naive keyword overlap. Good enough to unblock the Q&A flow before Moss is wired up. */
export function mockReviewIndex(): ReviewIndex {
  const store = new Map<string, RawReview[]>();
  return {
    async index(productId, reviews) {
      store.set(productId, [...(store.get(productId) ?? []), ...reviews]);
      return ok({ chunks: reviews.length });
    },
    async search(productId, query, k = 3) {
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const scored = (store.get(productId) ?? [])
        .map((r) => ({ r, score: words.filter((w) => r.body.toLowerCase().includes(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      return ok(scored.slice(0, k).map((x) => x.r));
    },
  };
}

export function mockPreferenceStore(seed: UserProfile = fixtures.profile): PreferenceStore {
  const profiles = new Map<string, UserProfile>([[seed.userId, structuredClone(seed)]]);
  const get = (userId: string): UserProfile => {
    let p = profiles.get(userId);
    if (!p) {
      p = { userId, speechRate: 1, verbosity: "normal", facts: [], purchases: [] };
      profiles.set(userId, p);
    }
    return p;
  };
  return {
    async getProfile(userId) {
      return ok(get(userId));
    },
    async upsertFact(userId, fact: PreferenceFact) {
      const p = get(userId);
      p.facts = [...p.facts.filter((f) => f.id !== fact.id), fact];
      return ok(fact);
    },
    async recordPurchase(userId, purchase: PurchaseRecord) {
      get(userId).purchases.push(purchase);
      return ok(purchase);
    },
    async recall(userId, query, k = 5) {
      const q = query.toLowerCase();
      const p = get(userId);
      const hit = (s: string) => q.split(/\W+/).some((w) => w.length > 2 && s.toLowerCase().includes(w));
      return ok({
        facts: p.facts.filter((f) => hit(`${f.value} ${f.detail ?? ""} ${f.evidence}`)).slice(0, k),
        purchases: p.purchases.filter((x) => hit(`${x.title} ${x.query}`)).slice(0, k),
      });
    },
  };
}

export function consoleVoice(log: (line: string) => void = console.log): VoiceOut {
  return {
    say: (text, opts) => log(`[voice:${opts?.kind ?? "answer"}] ${text}`),
    stop: () => log("[voice] stop"),
  };
}

/** Always returns the fixture Amazon search page. Lets the Navigator be developed without a browser. */
export function fixtureDriver(): BrowserDriver {
  return {
    async openTab() {
      return ok({ tabId: fixtures.pageState.tabId });
    },
    async navigate(_tabId, url) {
      return ok({ url });
    },
    async snapshot(tabId) {
      return ok({ ...fixtures.pageState, tabId });
    },
    async act(tabId, action) {
      if ("idx" in action && fixtures.pageState.elements[action.idx]?.purchaseRisk) {
        return err("forbidden_action", "Refusing to click a purchase button");
      }
      return ok({ navigated: action.kind === "click" });
    },
    async screenshot() {
      return ok({ dataUrl: "data:image/png;base64," });
    },
    async closeTab() {
      return ok({});
    },
  };
}

export function mockServices(opts: MockOptions = {}): Services {
  return {
    navigator: mockNavigator(opts),
    reviews: mockReviewService(opts),
    vision: mockVisionService(opts),
    reviewIndex: mockReviewIndex(),
    prefs: mockPreferenceStore(),
    voice: consoleVoice(),
  };
}

export const noopEmit: Emit = () => {};
