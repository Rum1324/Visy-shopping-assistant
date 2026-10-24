/**
 * Interfaces between modules INSIDE the server. Each track implements one or more of these.
 * The conversation agent depends only on these interfaces, never on concrete classes,
 * so any implementation can be swapped for its mock in src/mocks.ts.
 */
import type { Emit, Marketplace, ProductId, Result } from "./common.ts";
import type { ReviewSynthesis, VisualDescription } from "./insights.ts";
import type { PageState } from "./driver.ts";
import type { Need } from "./need.ts";
import type { PreferenceFact, PurchaseRecord, UserProfile } from "./prefs.ts";
import type { ProductCandidate, ProductDetail, RawReview } from "./product.ts";
import type { CartLine, CheckoutReview } from "./session.ts";

/** Track C. Only the Navigator talks to Jev. Confirm the real API shape and adapt it inside the implementation. */
export interface JevClient {
  decide(input: {
    state: string; // serialized PageState (or a slice of it)
    question: string;
    options: string[];
  }): Promise<Result<{ choice: string; confidence: number }>>;
}

/**
 * Track C. One step of a plan that Claude writes once per task, e.g. for "add to cart":
 *   [{ kind: "find_control", intent: "button: Add to Cart | section: main buy box" }, …]
 * Pickers execute "find_control" steps. "judgment" steps ("the cheapest of these 3") always go to Claude.
 */
export type PlanStep =
  | { kind: "find_control"; intent: string; then: "click" | "type" | "select"; text?: string }
  | { kind: "judgment"; question: string }
  | { kind: "navigate"; url: string };

/** Track C. Result of choosing an element for a find_control step. Log every one: this is the bake-off data. */
export type PickResult = {
  idx: number;
  score: number;
  /** Second-best score. Moss trusts a pick only when score − runnerUpScore ≥ the gap you tuned. */
  runnerUpScore?: number;
  picker: "jev" | "moss" | "recipe" | "claude";
  /** Time to choose the element. */
  latencyMs: number;
  /** Time to index the page first (Moss). Measure it: it may dominate latencyMs. */
  indexMs?: number;
};

/**
 * Track C. Strategy for choosing an element. Implementations: JevPicker, MossPicker, ClaudePicker, RecipePicker.
 * The Navigator chains them (e.g. recipe → moss|jev → claude) and moves on when `trusted` is false.
 */
export interface ElementPicker {
  readonly name: PickResult["picker"];
  pick(state: PageState, step: Extract<PlanStep, { kind: "find_control" }>): Promise<Result<PickResult & { trusted: boolean }>>;
}

/** Track C. All browser work. Uses a BrowserDriver and a chain of ElementPickers internally, with Claude as the final fallback. */
export interface Navigator {
  search(need: Need, marketplace: Marketplace, emit: Emit): Promise<Result<ProductCandidate[]>>;
  getDetail(candidate: ProductCandidate, emit: Emit): Promise<Result<ProductDetail>>;
  addToCart(productId: ProductId, quantity: number, emit: Emit): Promise<Result<CartLine>>;
  /** Navigates to the final review page and extracts it. MUST stop before placing the order. */
  openCheckout(marketplace: Marketplace, emit: Emit): Promise<Result<CheckoutReview>>;
}

/** Track D. */
export interface ReviewService {
  /** Reviews from outside the retailer: Reddit, YouTube transcripts, articles (Apify). */
  collectExternal(product: ProductDetail, emit: Emit): Promise<Result<RawReview[]>>;
  synthesize(product: ProductDetail, reviews: RawReview[], need: Need): Promise<Result<ReviewSynthesis>>;
}

/** Track D. */
export interface VisionService {
  describe(product: ProductCandidate | ProductDetail): Promise<Result<VisualDescription>>;
}

/** Track D (Moss). Retrieval over the current shortlist's reviews, for fast follow-up answers. */
export interface ReviewIndex {
  index(productId: ProductId, reviews: RawReview[]): Promise<Result<{ chunks: number }>>;
  search(productId: ProductId, query: string, k?: number): Promise<Result<RawReview[]>>;
}

/** Track B (Moss-backed). */
export interface PreferenceStore {
  getProfile(userId: string): Promise<Result<UserProfile>>;
  upsertFact(userId: string, fact: PreferenceFact): Promise<Result<PreferenceFact>>;
  recordPurchase(userId: string, purchase: PurchaseRecord): Promise<Result<PurchaseRecord>>;
  /** "the usual seaweed" → relevant facts and past purchases. */
  recall(userId: string, query: string, k?: number): Promise<Result<{ facts: PreferenceFact[]; purchases: PurchaseRecord[] }>>;
}

/** Track A, server side. The agent calls this to speak; the voice gateway handles TTS, queueing and barge-in. */
export interface VoiceOut {
  say(text: string, opts?: { kind?: "answer" | "progress" | "question"; interruptible?: boolean }): void;
  stop(): void;
}

/** Everything the conversation agent needs, injected at startup. Swap any field for its mock. */
export interface Services {
  navigator: Navigator;
  reviews: ReviewService;
  vision: VisionService;
  reviewIndex: ReviewIndex;
  prefs: PreferenceStore;
  voice: VoiceOut;
}
