/**
 * Track B. Owns SessionState. Calls Services only.
 * Never places an order and never clicks a purchase button.
 */
import {
  CONTRACT_VERSION,
  Need,
  SessionState as SessionStateSchema,
  type Emit,
  type Money,
  type ProductCandidate,
  type ServerMsg,
  type SessionState,
  type Services,
  type ShortlistItem,
} from "@visy/contracts";

export type SayKind = "answer" | "progress" | "question";

export type AgentSink = {
  send: (msg: ServerMsg) => void;
  say: (text: string, kind?: SayKind) => Promise<void>;
  stopSpeaking: () => void;
};

export function createAgent(services: Services, sink: AgentSink) {
  let state: SessionState | null = null;
  let run = 0;
  let speechRate = 1;

  const emit: Emit = (event) => {
    sink.send({ type: "progress", event });
    void sink.say(event.message, "progress");
  };

  function publish(next: SessionState) {
    state = SessionStateSchema.parse({ ...next, updatedAt: new Date().toISOString() });
    sink.send({ type: "session.snapshot", state });
  }

  async function hello(userId: string) {
    const profile = await services.prefs.getProfile(userId);
    if (profile.ok) speechRate = profile.data.speechRate;
    publish(
      SessionStateSchema.parse({
        sessionId: `s-${Date.now()}`,
        userId,
        phase: "idle",
        candidates: [],
        shortlist: [],
        cart: [],
        updatedAt: new Date().toISOString(),
      }),
    );
    sink.send({ type: "welcome", sessionId: state!.sessionId, protocol: CONTRACT_VERSION });
  }

  function interrupt() {
    run++;
    sink.stopSpeaking();
  }

  async function handleText(text: string) {
    const id = ++run;
    const said = text.trim();
    if (!said) return;
    if (!state) {
      sink.send({ type: "error", error: { code: "internal", message: "Say hello first", retryable: true } });
      return;
    }
    sink.send({ type: "transcript", text: said, final: true });
    if (state.shortlist.length && /\b(add to cart|add it|add this|add the|option\s*[123]|number\s*[123])\b/i.test(said)) {
      await addToCart(optionIndex(said), id);
      return;
    }
    if (/\b(usual|seaweed)\b/i.test(said)) {
      const recalled = await services.prefs.recall(state.userId, said);
      const purchase = recalled.ok ? recalled.data.purchases[0] : undefined;
      if (purchase) {
        await sink.say(`Your usual is ${purchase.title}, $${(purchase.price.cents / 100).toFixed(2)} on ${purchase.marketplace}.`);
        return;
      }
    }
    await shop(said, id);
  }

  async function confirm(total: Money) {
    if (!state?.checkout) return;
    if (state.checkout.total.cents !== total.cents) {
      await sink.say(`That does not match the $${(state.checkout.total.cents / 100).toFixed(2)} I read back. I will not continue.`);
      return;
    }
    publish({ ...state, phase: "done" });
    await sink.say("That matches the total I read back. I will not press Place order. That button is yours.");
  }

  async function shop(text: string, id: number) {
    if (!state) return;
    const need = Need.parse({ query: text.trim(), marketplaces: ["amazon", "target", "walmart"] });
    publish({ ...state, phase: "searching", need, candidates: [], shortlist: [], cart: [] });
    await sink.say(`${need.query}. I'll check Amazon, Target, and Walmart.`);
    if (id !== run || !state) return;
    const results = await Promise.all(need.marketplaces.map((m) => services.navigator.search(need, m, emit)));
    if (id !== run || !state) return;
    const candidates = results.flatMap((r) => (r.ok ? r.data : []));
    const picks = bestPerMarketplace(candidates);
    const shortlist: ShortlistItem[] = [];
    for (const candidate of picks) {
      if (id !== run || !state) return;
      const detail = await services.navigator.getDetail(candidate, emit);
      const product = detail.ok ? detail.data : candidate;
      let reviews: ShortlistItem["reviews"];
      let visual: ShortlistItem["visual"];
      if (detail.ok) {
        const external = await services.reviews.collectExternal(detail.data, emit);
        const pool = [...detail.data.retailerReviews, ...(external.ok ? external.data : [])];
        if (pool.length) await services.reviewIndex.index(detail.data.id, pool);
        const synth = await services.reviews.synthesize(detail.data, pool, need);
        if (synth.ok) reviews = synth.data;
        const vis = await services.vision.describe(detail.data);
        if (vis.ok) visual = vis.data;
      }
      const item: ShortlistItem = {
        rank: (shortlist.length + 1) as 1 | 2 | 3,
        product,
        reviews,
        visual,
        whyPicked: reviews?.summary ?? `Available at ${candidate.marketplace}.`,
      };
      shortlist.push(item);
      publish({
        ...state,
        phase: shortlist.length === picks.length ? "presenting" : "shortlisting",
        candidates,
        shortlist: [...shortlist],
        focusedProductId: product.id,
      });
      const price = `$${(product.price.cents / 100).toFixed(2)}`;
      await sink.say(`Option ${item.rank}: ${product.title}, ${price}. ${visual?.short ?? ""} ${reviews?.summary ?? ""}`);
    }
  }

  async function addToCart(index: number, id: number) {
    if (!state) return;
    const item = state.shortlist[index];
    if (!item) {
      await sink.say("Tell me option 1, 2, or 3.");
      return;
    }
    publish({ ...state, phase: "carting", focusedProductId: item.product.id });
    const line = await services.navigator.addToCart(item.product.id, state.need?.quantity ?? 1, emit);
    if (id !== run || !state || !line.ok) {
      if (state) publish({ ...state, phase: "presenting" });
      await sink.say("I couldn't add that to the cart.");
      return;
    }
    publish({ ...state, cart: [...state.cart, line.data] });
    const review = await services.navigator.openCheckout(item.product.marketplace, emit);
    if (id !== run || !state || !review.ok) {
      if (state) publish({ ...state, phase: "presenting" });
      await sink.say("I couldn't open checkout.");
      return;
    }
    const readBack = `${item.product.title}. Total $${(review.data.total.cents / 100).toFixed(2)}. I will not place the order. Press Place your order when you are ready.`;
    const checkout = { ...review.data, readBack };
    publish({ ...state, phase: "checkout_review", checkout });
    sink.send({ type: "checkout.confirmRequired", review: checkout });
    await sink.say(readBack, "question");
  }

  return {
    hello,
    interrupt,
    handleText,
    confirm,
    setSpeech(patch: { speechRate?: number }) {
      if (patch.speechRate != null) speechRate = patch.speechRate;
    },
    get speechRate() {
      return speechRate;
    },
    get state() {
      return state;
    },
  };
}

function bestPerMarketplace(candidates: ProductCandidate[]): ProductCandidate[] {
  const best = new Map<string, ProductCandidate>();
  for (const c of candidates) {
    const prev = best.get(c.marketplace);
    const s = (c.rating ?? 0) * 1000 - c.price.cents / 100;
    const ps = prev ? (prev.rating ?? 0) * 1000 - prev.price.cents / 100 : -Infinity;
    if (!prev || s > ps) best.set(c.marketplace, c);
  }
  return [...best.values()].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 3);
}

function optionIndex(text: string): number {
  const match = text.match(/(?:option|number)\s*([123])/i);
  if (match) return Number(match[1]) - 1;
  if (/\bsecond\b/i.test(text)) return 1;
  if (/\bthird\b/i.test(text)) return 2;
  return 0;
}
