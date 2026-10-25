/**
 * Track B. Owns SessionState. Calls Services only.
 * Never places an order and never clicks a purchase button.
 * Each user turn is routed by a Claude tool loop (agent-tools.ts); keyword routing is the fallback.
 */
import Anthropic from "@anthropic-ai/sdk";
import { INPUTS, MODEL, SYSTEM, TIMEOUT_MS, TOOLS, turnMessage, untrusted, type Llm, type ToolName } from "./agent-tools.ts";
import { prefetchApifySearch, reviewsFromHits } from "./intel/apify.ts";
import { sourcesSentence } from "./intel/reviews.ts";
import {
  CONTRACT_VERSION,
  Need,
  PreferenceFact,
  SessionState as SessionStateSchema,
  type Emit,
  type Marketplace,
  type Money,
  type PageState,
  type ProductCandidate,
  type ProgressEvent,
  type Result,
  type ReviewSynthesis,
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
  /** The user's open tab as a PageState (Track C5), for Track D's "what's on this page?". Text in it is untrusted. */
  capturePage?: (opts?: { tabId?: number; maxElements?: number }) => Promise<Result<PageState>>;
};

const YES = /^(yes|confirm|that matches)\b/i;
const ACK_MS = 800;

function defaultLlm(): Llm | null {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;
  // ANTHROPIC_BASE_URL may be set by the host shell for other tools; pin the public API unless VISY_ANTHROPIC_BASE_URL says otherwise.
  return new Anthropic({ baseURL: process.env.VISY_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" });
}

/** `llm: null` forces keyword routing. Omit it to use Claude when ANTHROPIC_API_KEY is set. */
export function createAgent(services: Services, sink: AgentSink, opts: { llm?: Llm | null } = {}) {
  const llm = opts.llm === undefined ? defaultLlm() : opts.llm;
  let state: SessionState | null = null;
  let run = 0;
  let speechRate = 1;
  let spoken = 0;
  let turnAbort: AbortController | null = null;
  const recent: string[] = [];

  function say(text: string, kind?: SayKind) {
    spoken++;
    return sink.say(text, kind);
  }

  const emit: Emit = (event) => {
    sink.send({ type: "progress", event });
  };

  /** In-place thinking line in the chat (spoken). Empty message clears it. */
  function think(message: string, stage: ProgressEvent["stage"] = "reviews") {
    const text = message.trim();
    emit({ stage, message: text, at: new Date().toISOString() });
    if (text) void say(text, "progress");
  }

  function publish(next: SessionState) {
    state = SessionStateSchema.parse({ ...next, updatedAt: new Date().toISOString() });
    sink.send({ type: "session.snapshot", state });
  }

  async function hello(userId: string, displayName?: string) {
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
    const name = displayName?.trim();
    await sink.say(name ? `Hi ${name}, What can I do for you today?` : "Hi, What can I do for you today?", "question");
  }

  function interrupt() {
    run++;
    turnAbort?.abort();
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
    // The checkout gate stays a fixed rule, before Claude sees the turn.
    if (state.phase === "checkout_review" && state.checkout && YES.test(said)) {
      await confirm(state.checkout.total);
      return;
    }
    const handled = llm ? await routeWithClaude(llm, said, id) : false;
    recent.push(said);
    if (recent.length > 3) recent.shift();
    if (handled || id !== run) return;
    await routeByKeywords(said, id);
  }

  /** Returns false when nothing was said or done, so the caller falls back to keyword routing. */
  async function routeWithClaude(llm: Llm, said: string, id: number): Promise<boolean> {
    if (!state) return false;
    const ac = new AbortController();
    turnAbort = ac;
    const before = spoken;
    const turn = { said, id, tainted: false, fallback: "" };
    const ack = setTimeout(() => {
      if (id === run && spoken === before) void sink.say("One moment.");
    }, ACK_MS);
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: turnMessage(state, said, recent) }];
    try {
      for (let step = 0; step < 4; step++) {
        const res = await llm.messages.create(
          { model: MODEL, max_tokens: 1024, system: SYSTEM, tools: TOOLS, output_config: { effort: "low" }, messages },
          { signal: ac.signal, timeout: TIMEOUT_MS, maxRetries: 0 },
        );
        if (id !== run || !state) return true;
        const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (!calls.length) {
          const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
          if (text) await say(text);
          else if (turn.fallback) await say(turn.fallback);
          return spoken > before;
        }
        messages.push({ role: "assistant", content: res.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        let allSpoke = true;
        for (const call of calls) {
          const s0 = spoken;
          const out = await runTool(call, turn);
          if (id !== run) return true;
          if (spoken === s0) allSpoke = false;
          results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, is_error: out.error });
        }
        // Tools that spoke have finished the turn. Skip the extra round trip so the next utterance is not held up.
        if (allSpoke) return true;
        messages.push({ role: "user", content: results });
      }
      if (turn.fallback && spoken === before) await say(turn.fallback);
      return spoken > before;
    } catch (e) {
      if (id !== run) return true;
      console.warn("claude routing failed, using keywords:", e instanceof Error ? e.message : e);
      if (turn.fallback && spoken === before) await say(turn.fallback);
      return spoken > before;
    } finally {
      clearTimeout(ack);
      if (turnAbort === ac) turnAbort = null;
    }
  }

  type Turn = { said: string; id: number; tainted: boolean; fallback: string };
  type ToolOut = { content: string; error?: boolean };
  const fail = (content: string): ToolOut => ({ content, error: true });

  async function runTool(call: Anthropic.ToolUseBlock, turn: Turn): Promise<ToolOut> {
    const schema = INPUTS[call.name as ToolName];
    if (!schema) return fail(`Unknown tool ${call.name}.`);
    const parsed = schema.safeParse(call.input);
    if (!parsed.success) return fail(`Invalid input: ${parsed.error.issues[0]?.message ?? "bad arguments"}.`);
    const input = parsed.data as Record<string, any>;
    if (!state) return fail("No session.");
    // Review and page text entered this turn: nothing that changes the cart or saved preferences may follow it.
    if (turn.tainted && ["add_to_cart", "confirm_checkout_total", "remember_as_usual"].includes(call.name)) {
      return fail("Refused: review text was read this turn, so cart and memory actions need a fresh request from the user.");
    }
    switch (call.name as ToolName) {
      case "search":
        await shop(input.query, turn.id, input.marketplaces);
        return { content: `Read ${state?.shortlist.length ?? 0} options aloud.` };
      case "filter_shortlist":
        if (!state.shortlist.length) return fail("There is no shortlist yet. Search first.");
        if (input.maxPriceCents == null && input.minRating == null) return fail("Give maxPriceCents or minRating.");
        await filterShortlist(input.maxPriceCents, input.minRating, turn.id);
        return { content: "Read the filtered shortlist aloud." };
      case "answer_about_product":
        return answerAbout(input.question, input.index, turn);
      case "add_to_cart":
        if (!state.shortlist.length) return fail("There is no shortlist yet. Search first.");
        await addToCart(input.index - 1, turn.id);
        return { content: state?.phase === "checkout_review" ? "Read the checkout total back. Waiting for the user." : "Did not reach checkout." };
      case "confirm_checkout_total":
        if (state.phase !== "checkout_review" || !state.checkout) return fail("No checkout read-back is waiting for confirmation.");
        if (!YES.test(turn.said)) return fail("Refused: the user must say yes to the total I read back. Ask them to say yes to confirm.");
        await confirm(state.checkout.total);
        return { content: "Confirmed the total. The order was not placed." };
      case "recall_usual":
        return (await recallUsual(input.query)) ? { content: "Told the user their usual." } : { content: "No usual item is saved for that." };
      case "remember_as_usual":
        await remember(turn.said, input.index);
        return { content: "Done." };
      case "ask_clarifying_question":
        await say(input.text, "question");
        return { content: "Asked." };
    }
  }

  async function answerAbout(question: string, index: number | undefined, turn: Turn): Promise<ToolOut> {
    if (!state?.shortlist.length) return fail("There is no shortlist yet. Search first.");
    const items = index ? state.shortlist.filter((item) => item.rank === index) : state.shortlist;
    if (!items.length) return fail(`There is no option ${index}.`);
    publish({ ...state, phase: "qa" });
    const words = question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    let best = 0;
    const data = [];
    for (const item of items) {
      const found = await services.reviewIndex.search(item.product.id, question, 3);
      const reviews = found.ok ? found.data.map((r) => (r.title ? `${r.title}. ${r.body}` : r.body).slice(0, 400)) : [];
      for (const body of reviews) {
        const score = words.filter((w) => body.toLowerCase().includes(w)).length;
        if (score > best) {
          best = score;
          turn.fallback = `Reviewers say: ${body.slice(0, 180)}`;
        }
      }
      const product = item.product;
      data.push({
        option: item.rank,
        title: product.title,
        description: "description" in product ? product.description.slice(0, 400) : undefined,
        bullets: "bullets" in product ? product.bullets.slice(0, 5) : undefined,
        reviewSummary: item.reviews?.summary,
        cons: item.reviews?.cons,
        reviewWarnings: item.reviews?.warnings,
        // Track D: accessibility answers from the synthesis and what the photo shows.
        accessibility: item.reviews?.accessibility.filter((a) => a.sentiment !== "unknown").map((a) => ({ question: a.question, answer: a.answer })),
        looks: item.visual ? `${item.visual.short} ${item.visual.detailed}` : undefined,
        reviews,
      });
    }
    turn.tainted = true;
    if (!turn.fallback) turn.fallback = "I don't have a review that answers that.";
    if (state) publish({ ...state, phase: "presenting" });
    return {
      content: `${untrusted("reviews", data)}\n\nAnswer the user's question from this data in one or two spoken sentences and say which option. If the data does not answer it, say you don't know.`,
    };
  }

  async function routeByKeywords(said: string, id: number) {
    if (!state) return;
    if (state.shortlist.length && /\badd\b/i.test(said)) {
      await addToCart(optionIndex(said), id);
      return;
    }
    if (state.candidates.length && /\bunder\s+\$?\s*\d+/i.test(said)) {
      await refine(said, id);
      return;
    }
    if (state.shortlist.length && /\?/ .test(said)) {
      await answerQuestion(said, id);
      return;
    }
    if (/\bremember this\b/i.test(said)) {
      await remember(said);
      return;
    }
    if (/\busual\b/i.test(said) && (await recallUsual(said))) return;
    await shop(said, id);
  }

  async function recallUsual(query: string) {
    if (!state) return false;
    const recalled = await services.prefs.recall(state.userId, query);
    const purchase = recalled.ok ? recalled.data.purchases[0] : undefined;
    if (purchase) {
      await say(`Your usual is ${purchase.title}, $${(purchase.price.cents / 100).toFixed(2)} on ${purchase.marketplace}.`);
      return true;
    }
    const fact = recalled.ok ? recalled.data.facts.find((item) => item.kind === "usual_item") : undefined;
    if (fact) {
      await say(`Your usual is ${fact.detail ?? fact.value}.`);
      return true;
    }
    return false;
  }

  async function refine(text: string, id: number) {
    const match = text.match(/under\s+\$?\s*(\d+(?:\.\d+)?)/i);
    if (!match) return;
    await filterShortlist(Math.round(Number(match[1]) * 100), undefined, id);
  }

  async function filterShortlist(cents: number | undefined, minRating: number | undefined, id: number) {
    if (!state) return;
    const kept = state.shortlist.filter(
      (item) => (cents == null || item.product.price.cents <= cents) && (minRating == null || (item.product.rating ?? 0) >= minRating),
    );
    if (!kept.length) {
      await say(
        cents != null
          ? `Nothing on the shortlist is under $${(cents / 100).toFixed(2)}.`
          : `Nothing on the shortlist is rated ${minRating} stars or higher.`,
      );
      return;
    }
    const shortlist = kept.map((item, i) => ({ ...item, rank: i + 1 }));
    publish({ ...state, phase: "presenting", shortlist, focusedProductId: shortlist[0]!.product.id });
    if (id !== run) return;
    await say(formatShortlistRoster(shortlist));
  }

  async function answerQuestion(text: string, id: number) {
    if (!state) return;
    publish({ ...state, phase: "qa" });
    // D2: Moss ranks by meaning within a product, so each product's top hit is its best answer even with no shared words.
    // Across products: most word overlap wins; with none, the focused product's hit.
    // "does option 2 …" / "is the second one …" asks about that product only.
    const named = /(?:option|number)\s*[123]\b|\b(first|second|third)\b/i.test(text) ? state.shortlist[optionIndex(text)] : undefined;
    const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const hits = await Promise.all(
      (named ? [named] : state.shortlist).map(async (item) => {
        const found = await services.reviewIndex.search(item.product.id, text, 3);
        const top = found.ok ? found.data[0] : undefined;
        const body = top ? (top.title ? `${top.title}. ${top.body}` : top.body) : "";
        const overlap = words.filter((w) => body.toLowerCase().includes(w)).length;
        return { item, body, overlap, focused: item.product.id === state?.focusedProductId };
      }),
    );
    const best = hits
      .filter((h) => h.body)
      .sort((a, b) => b.overlap - a.overlap || Number(b.focused) - Number(a.focused))[0];
    const quote = best?.body ?? "";
    const about = best && state.shortlist.length > 1 ? `For option ${best.item.rank}, ` : "";
    if (id !== run || !state) return;
    await say(quote ? `${about || "A"}${about ? "a" : ""} reviewer says: ${quote.slice(0, 220)}` : "I don't have a review that answers that.");
    if (id !== run || !state) return;
    publish({ ...state, phase: "presenting" });
  }

  async function confirm(total: Money) {
    if (!state?.checkout) return;
    if (state.checkout.total.cents !== total.cents) {
      await say(`That does not match the $${(state.checkout.total.cents / 100).toFixed(2)} I read back. I will not continue.`);
      return;
    }
    for (const line of state.checkout.lines) {
      await saveUsual(line.productId, line.title, "You confirmed this cart. Visy did not place the order.");
    }
    publish({ ...state, phase: "done" });
    await say("That matches the total I read back. I will not press Place order. That button is yours. I saved it as your usual.");
  }

  async function shop(text: string, id: number, marketplaces: Marketplace[] = ["amazon", "target", "walmart"]) {
    if (!state) return;
    const need = Need.parse({ query: text.trim(), marketplaces });
    publish({ ...state, phase: "searching", need, candidates: [], shortlist: [], cart: [] });
    const names = need.marketplaces.map((m) => m[0]!.toUpperCase() + m.slice(1));
    const where =
      names.length < 3
        ? `I'll check ${names.join(" and ")}.`
        : process.env.NAV === "amazon"
          ? "I'll check Amazon. Target and Walmart stay on sample listings."
          : "I'll check Amazon, Target, and Walmart.";
    await say(where);
    if (id !== run || !state) return;
    // Kick off Apify immediately (Reddit + YouTube + articles in parallel) beside marketplace search.
    think("Searching Reddit, YouTube, and articles for reviews…", "reviews");
    const apifyHitsP = prefetchApifySearch(need.query, { mustHaves: need.mustHaves });
    const results = await Promise.all(need.marketplaces.map((m) => services.navigator.search(need, m, emit)));
    if (id !== run || !state) return;
    const candidates = results.flatMap((r) => (r.ok ? r.data : []));
    const picks = bestPerMarketplace(candidates);
    const shortlist: ShortlistItem[] = [];
    for (const candidate of picks) {
      if (id !== run || !state) return;
      const rank = (shortlist.length + 1) as 1 | 2 | 3;
      const store = candidate.marketplace[0]!.toUpperCase() + candidate.marketplace.slice(1);
      think(`Reading option ${rank} on ${store}…`, "reading_product");
      const detail = await services.navigator.getDetail(candidate, emit);
      const product = detail.ok ? detail.data : candidate;
      let reviews: ShortlistItem["reviews"];
      let visual: ShortlistItem["visual"];
      if (detail.ok) {
        const synthP = (async () => {
          think(`Waiting on outside reviews for option ${rank}…`, "reviews");
          const hits = await apifyHitsP;
          const external = reviewsFromHits(detail.data.id, hits);
          const by = external.reduce<Partial<Record<string, number>>>((acc, r) => {
            acc[r.source] = (acc[r.source] ?? 0) + 1;
            return acc;
          }, {});
          const bits = (["reddit", "youtube", "article"] as const)
            .filter((s) => by[s])
            .map((s) => (s === "article" ? "articles" : s === "youtube" ? "YouTube" : "Reddit"));
          think(
            bits.length ? `Using outside reviews from ${bits.join(", ")}…` : "Using retailer reviews only…",
            "reviews",
          );
          think(`Summarizing option ${rank}…`, "reviews");
          const pool = [...detail.data.retailerReviews, ...external];
          const [, synth] = await Promise.all([
            pool.length ? services.reviewIndex.index(detail.data.id, pool) : undefined,
            services.reviews.synthesize(detail.data, pool, need),
          ]);
          return synth;
        })();
        const [synth, vis] = await Promise.all([synthP, services.vision.describe(detail.data)]);
        if (synth.ok) reviews = synth.data;
        if (vis.ok) visual = vis.data;
      }
      const item: ShortlistItem = {
        rank,
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
    }
    if (id !== run || !state || !shortlist.length) return;
    think("");
    // One spoken/captioned block so newlines stay intact and TTS isn't chopped into many turns.
    await say(
      [
        formatShortlistRoster(shortlist),
        "",
        ...shortlist.map((item) => formatProsConsSection(item.rank, item.product.marketplace, item.reviews)),
      ].join("\n\n"),
    );
  }

  async function addToCart(index: number, id: number) {
    if (!state) return;
    const item = state.shortlist[index];
    if (!item) {
      await say("Tell me option 1, 2, or 3.");
      return;
    }
    publish({ ...state, phase: "carting", focusedProductId: item.product.id });
    const line = await services.navigator.addToCart(item.product.id, state.need?.quantity ?? 1, emit);
    if (id !== run || !state || !line.ok) {
      if (state) publish({ ...state, phase: "presenting" });
      await say("I couldn't add that to the cart.");
      return;
    }
    publish({ ...state, cart: [...state.cart, line.data] });
    const review = await services.navigator.openCheckout(item.product.marketplace, emit);
    if (id !== run || !state || !review.ok) {
      if (state) publish({ ...state, phase: "presenting" });
      await say("I couldn't open checkout.");
      return;
    }
    const readBack = `${review.data.readBack} I will not place the order. Press Place your order when you are ready.`;
    const checkout = { ...review.data, readBack };
    publish({ ...state, phase: "checkout_review", checkout });
    sink.send({ type: "checkout.confirmRequired", review: checkout });
    await say(readBack, "question");
  }

async function remember(evidence: string, index?: number) {
  const session = state;
  if (!session) return;
  const product =
    (index ? session.shortlist.find((item) => item.rank === index)?.product : undefined) ??
    session.shortlist.find((item) => item.product.id === session.focusedProductId)?.product ??
    session.shortlist[0]?.product;
  if (!product) {
    await say("Tell me which option to remember.");
    return;
  }
  const saved = await saveUsual(product.id, product.title, evidence);
  await say(saved ? `${product.title}. I saved that as your usual. I did not place an order.` : "I couldn't save that.");
}

async function saveUsual(productId: string, title: string, evidence: string) {
  if (!state) return false;
  const saved = await services.prefs.upsertFact(
    state.userId,
    PreferenceFact.parse({
      id: `usual-${productId}`,
      kind: "usual_item",
      value: productId,
      detail: title,
      evidence,
      confidence: 0.9,
      updatedAt: new Date().toISOString(),
    }),
  );
  return saved.ok;
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

/** Keep the first useful keywords from a noisy marketplace title. */
export function shortTitle(title: string, maxWords = 6) {
  const stop = new Set(["with", "and", "the", "for", "in", "a", "an", "of", "to", "by"]);
  const words = title
    .replace(/\(.*?\)/g, " ")
    .split(/[,|–—•]/)[0]!
    .replace(/[^\w\s.'/&+-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const kept: string[] = [];
  for (const w of words) {
    if (kept.length >= maxWords) break;
    if (kept.length >= 2 && stop.has(w.toLowerCase())) continue;
    kept.push(w);
  }
  return kept.join(" ") || title.slice(0, 40);
}

export function formatOptionLine(rank: number, title: string, priceCents: number) {
  return `Option ${rank}: ${shortTitle(title)}, $${(priceCents / 100).toFixed(2)}`;
}

/** Brief roster of all options (name + price only). */
export function formatShortlistRoster(items: Pick<ShortlistItem, "rank" | "product">[]) {
  return items.map((item) => formatOptionLine(item.rank, item.product.title, item.product.price.cents)).join("\n");
}

/**
 * Pros/cons block for one option. Labels Pros / Cons, then a Sources line.
 * Example:
 * Here are the pros and cons of option 1:
 * Pros:
 * - Truly waterproof
 * Cons:
 * - Color duller than photos
 * Sources: Reviews from Amazon and Reddit.
 */
export function formatProsConsSection(
  rank: number,
  marketplace: Marketplace,
  reviews: ReviewSynthesis | undefined,
) {
  const lines = [`Here are the pros and cons of option ${rank}:`];
  const pros = reviews?.pros ?? [];
  const cons = reviews?.cons ?? [];
  if (pros.length) {
    lines.push("Pros:");
    for (const p of pros) lines.push(`- ${p}`);
  }
  if (cons.length) {
    lines.push("Cons:");
    for (const c of cons) lines.push(`- ${c}`);
  }
  const sources = reviews ? sourcesSentence(reviews.sourceCounts, marketplace) : "";
  if (sources) lines.push(`Sources: ${sources}`);
  else if (!pros.length && !cons.length) lines.push("No review summary yet.");
  return lines.join("\n");
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
