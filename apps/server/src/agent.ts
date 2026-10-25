/**
 * Track B. Owns SessionState. Calls Services only.
 * Never places an order and never clicks a purchase button.
 * Each user turn is routed by a Claude tool loop (agent-tools.ts); keyword routing is the fallback.
 */
import Anthropic from "@anthropic-ai/sdk";
import { INPUTS, MODEL, SYSTEM, TIMEOUT_MS, TOOLS, turnMessage, untrusted, type Llm, type ToolName } from "./agent-tools.ts";
import { apifyToken, prefetchApifySearch, reviewsFromHits } from "./intel/apify.ts";
import { sourcesSentence } from "./intel/reviews.ts";
import { haikuJev, narrowWithReviews } from "./narrow.ts";
import { haikuRelevance, type RelevanceFilter } from "./relevance.ts";
import { createProgress } from "./progress.ts";
import { applySaved, confirmLine, favoriteStores, prefFact, savedBlock, stated, withFact, type PrefKind } from "./saved-prefs.ts";
import { overview, pitchWriter, saleNote, speakable, templateLine, withSale, type Option, type PitchWriter } from "./present.ts";
import {
  CONTRACT_VERSION,
  Need,
  PreferenceFact,
  SessionState as SessionStateSchema,
  type Emit,
  type JevClient,
  type Marketplace,
  type Money,
  type PageState,
  type ProductCandidate,
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
/** The user named an amount (or dropped the cap) this turn, so a follow-up search may change the budget. */
const SAYS_AMOUNT = /\d|\b(ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand)\b|\bno (budget|limit)\b|\bany price\b/i;
const DEFAULT_QUESTIONS = ["What's your budget?", "What matters most?"];
/** Asked after the answers, so the shopper can add specifics in their own words. */
const ANYTHING_ELSE = "Anything else you want to add?";
/** Ends the questions early and searches with what we have. */
const SKIP = /\b(just search|skip|search now|go ahead|that's (it|all))\b/i;
const NO_PREFERENCE = /^(no|nope|nothing|none|no preference|anything|whatever|just search|doesn't matter|dont care|don't care)\b/i;

/** Need fields beyond query and marketplaces, from the search tool or a keyword answer. */
type NeedExtra = Partial<Pick<Need, "budget" | "mustHaves" | "niceToHaves" | "accessibilityNotes" | "priorities">>;

function defaultLlm(): Llm | null {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;
  // ANTHROPIC_BASE_URL may be set by the host shell for other tools; pin the public API unless VISY_ANTHROPIC_BASE_URL says otherwise.
  return new Anthropic({ baseURL: process.env.VISY_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" });
}

/**
 * `llm: null` forces keyword routing. Omit it to use Claude when ANTHROPIC_API_KEY is set.
 * `jev` narrows the candidate pool to 3; omitted, it is the Haiku stand-in only when `llm` is also omitted (tests stay offline).
 * `relevance` drops keyword near-misses before narrowing; omitted, Haiku runs only when live (same as jev).
 * `clarify: false` skips the questions before a search (VISY_CLARIFY=0 does the same).
 */
export function createAgent(
  services: Services,
  sink: AgentSink,
  opts: {
    llm?: Llm | null;
    jev?: JevClient | null;
    relevance?: RelevanceFilter | null;
    pitch?: PitchWriter | null;
    clarify?: boolean;
  } = {},
) {
  const llm = opts.llm === undefined ? defaultLlm() : opts.llm;
  const live = opts.llm === undefined && !!llm;
  const jev = opts.jev !== undefined ? opts.jev : live ? haikuJev() : null;
  const relevance = opts.relevance !== undefined ? opts.relevance : live ? haikuRelevance() : null;
  const pitch = opts.pitch !== undefined ? opts.pitch : live ? pitchWriter() : null;
  const clarify = opts.clarify ?? process.env.VISY_CLARIFY !== "0";
  let state: SessionState | null = null;
  let run = 0;
  let speechRate = 1;
  let spoken = 0;
  let turnAbort: AbortController | null = null;
  const recent: string[] = [];
  /** The user's saved preference facts, loaded on hello and kept current by remember_preference. */
  let saved: PreferenceFact[] = [];
  /** Questions still to ask before searching, and the answers so far. */
  let asking: { questions: string[]; answers: { question: string; answer: string }[] } | null = null;
  /** Bumped by every new search, so a cancelled search's late details don't land on a newer shortlist. */
  let searches = 0;
  /** Settles when the current search's details, reviews and photos are all in. */
  let details: Promise<unknown> = Promise.resolve();

  function say(text: string, kind?: SayKind) {
    // Acks and progress lines aren't answers: the Claude loop uses `spoken` to tell whether a turn or tool answered.
    if (kind !== "progress") spoken++;
    return sink.say(speakable(text), kind);
  }

  const emit: Emit = (event) => {
    sink.send({ type: "progress", event });
  };

  // UX-PROGRESS: progress.ts sees everything said and sent, and fills long silences with what is running.
  const progress = createProgress(sink, { rate: () => speechRate });
  sink = progress.sink;

  function publish(next: SessionState) {
    state = SessionStateSchema.parse({ ...next, updatedAt: new Date().toISOString() });
    sink.send({ type: "session.snapshot", state });
  }

  async function hello(userId: string, displayName?: string) {
    const profile = await services.prefs.getProfile(userId);
    if (profile.ok) speechRate = profile.data.speechRate;
    saved = profile.ok ? stated(profile.data.facts) : [];
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
    // Cut off while reading the picks: they were already named, so the next turn is about them.
    if (state?.phase === "shortlisting" && state.shortlist.length) publish({ ...state, phase: "presenting" });
  }

  function handleText(text: string) {
    return progress.during(() => turn(text));
  }

  async function turn(text: string) {
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
    // Record the answer; any question still left is asked right away, no model call needed.
    if (state.phase === "clarifying" && asking?.questions.length) {
      asking.answers.push({ question: asking.questions.shift()!, answer: said });
      if (SKIP.test(said)) asking.questions = [];
      if (asking.questions.length) {
        await say(asking.questions[0]!, "question");
        return;
      }
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
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [savedBlock(saved), turnMessage(state, said, recent, asking?.answers)].filter(Boolean).join("\n\n") },
    ];
    try {
      for (let step = 0; step < 4; step++) {
        const t0 = performance.now();
        const res = await llm.messages.create(
          { model: MODEL, max_tokens: 1024, system: SYSTEM, tools: TOOLS, output_config: { effort: "low" }, messages },
          { signal: ac.signal, timeout: TIMEOUT_MS, maxRetries: 0 },
        );
        if (id !== run || !state) return true;
        const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        console.log(`router: ${MODEL} step ${step + 1} → ${calls.map((c) => c.name).join(", ") || "text"} in ${Math.round(performance.now() - t0)} ms`);
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
          progress.tool(call.name);
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
    if (turn.tainted && ["add_to_cart", "confirm_checkout_total", "remember_as_usual", "remember_preference"].includes(call.name)) {
      return fail("Refused: review text was read this turn, so cart and memory actions need a fresh request from the user.");
    }
    switch (call.name as ToolName) {
      case "search":
        // Questions come before the first search for a product, unless the user already answered them or said to just search.
        if (clarify && state.phase !== "clarifying" && !input.skipQuestions) {
          await askQuestions(input.query, DEFAULT_QUESTIONS, input.marketplaces);
          return { content: "Asked the shopper questions before searching. Wait for their answer." };
        }
        await shop(input.query, turn.id, input.marketplaces, {
          budget: searchBudget(input, state.need, turn.said),
          mustHaves: input.mustHaves,
          niceToHaves: input.niceToHaves,
          accessibilityNotes: input.accessibilityNotes,
        });
        return { content: `Read ${state?.shortlist.length ?? 0} options aloud.` };
      case "ask_shopping_questions":
        await askQuestions(input.query, input.questions, input.marketplaces);
        return { content: "Asked. Wait for the shopper's answer." };
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
      case "remember_preference":
        return rememberPreference(input.kind, input.value, turn.said);
      case "ask_clarifying_question":
        await say(input.text, "question");
        return { content: "Asked." };
    }
  }

  async function answerAbout(question: string, index: number | undefined, turn: Turn): Promise<ToolOut> {
    if (!state?.shortlist.length) return fail("There is no shortlist yet. Search first.");
    if (!(index ? state.shortlist.some((item) => item.rank === index) : true)) return fail(`There is no option ${index}.`);
    publish({ ...state, phase: "qa" });
    // Asked while the details were still loading: wait a little for reviews and the photo description.
    await Promise.race([details, new Promise((r) => setTimeout(r, 8000).unref())]);
    if (!state) return fail("No session.");
    const items = index ? state.shortlist.filter((item) => item.rank === index) : state.shortlist;
    if (!items.length) return fail(`There is no option ${index}.`);
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
        brand: product.brand,
        marketplace: product.marketplace,
        price: `$${(product.price.cents / 100).toFixed(2)}`,
        sale: saleNote(product),
        description: "description" in product ? product.description.slice(0, 400) : undefined,
        bullets: "bullets" in product ? product.bullets.slice(0, 5) : undefined,
        rating: product.rating,
        reviewCount: product.reviewCount,
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
      content: `${untrusted("reviews", data)}\n\nAnswer the user's question from this data in one or two spoken sentences and say which option (one short sentence per option when they asked about all of them). If the data does not answer it, say you don't know. Every product has a few unhappy reviews: don't bring up a complaint only one or two reviews make unless the user asked about exactly that, and then say it's a few reviews next to the overall rating.`,
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
    if (state.shortlist.length && (/\?/.test(said) || /^(is|are|does|do|did|how|what|which|describe|tell me)\b/i.test(said))) {
      await answerQuestion(said, id);
      return;
    }
    if (/\bremember this\b/i.test(said)) {
      await remember(said);
      return;
    }
    if (/\busual\b/i.test(said) && (await recallUsual(said))) return;
    if (state.phase === "clarifying" && state.need) {
      const answers = asking?.answers.map((a) => a.answer).filter((a) => !NO_PREFERENCE.test(a)).join(". ") || said;
      await shop(state.need.query, id, state.need.marketplaces, needFromAnswer(answers));
      return;
    }
    if (clarify) {
      await askQuestions(said, DEFAULT_QUESTIONS);
      return;
    }
    await shop(said, id);
  }

  /**
   * Asks up to 2 short questions together in one turn: one at a time was too slow, three at once too long.
   * The next user turn is the answer (phase "clarifying"), then "Anything else you want to add?" gets its own turn.
   */
  async function askQuestions(query: string, questions: string[], marketplaces: Marketplace[] = favoriteStores(saved) ?? ["amazon", "target", "walmart"]) {
    if (!state) return;
    const need = Need.parse({ query: query.trim(), marketplaces });
    const together = questions.slice(0, 2).join(" ");
    asking = { questions: [together, ANYTHING_ELSE], answers: [] };
    searches++;
    publish({ ...state, phase: "clarifying", need, candidates: [], shortlist: [], cart: [] });
    await say(`Sure, ${need.query}. ${together}`, "question");
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
    await say("Got it, I saved that as your usual. The final button is yours whenever you're ready.");
  }

  async function shop(text: string, id: number, marketplaces: Marketplace[] = favoriteStores(saved) ?? ["amazon", "target", "walmart"], extra: NeedExtra = {}) {
    if (!state) return;
    const defined = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
    const need = applySaved(Need.parse({ query: text.trim(), marketplaces, ...defined }), saved);
    asking = null;
    const search = ++searches;
    const before = state;
    publish({ ...state, phase: "searching", need, candidates: [], shortlist: [], cart: [] });
    const names = need.marketplaces.map((m) => m[0]!.toUpperCase() + m.slice(1));
    const where =
      names.length < 3
        ? `I'll check ${names.join(" and ")}${need.marketplaces.join() === favoriteStores(saved)?.join() ? ", your favorite store" : ""}.`
        : process.env.NAV === "amazon"
          ? "I'll check Amazon, Target, and Walmart."
          : "I'll check Amazon, Target, and Walmart.";
    await say(where);
    if (id !== run || !state) return;
    // Kick off Apify immediately (Reddit + YouTube + articles in parallel) beside marketplace search.
    const usingApify = Boolean(apifyToken());
    emit({
      stage: "reviews",
      message: usingApify
        ? "Using Apify to search Reddit, YouTube, and articles"
        : "Searching Reddit, YouTube, and articles for reviews",
      at: new Date().toISOString(),
    });
    const apifyHitsP = prefetchApifySearch(need.query, { mustHaves: need.mustHaves });
    const results = await Promise.all(need.marketplaces.map((m) => services.navigator.search(need, m, emit)));
    if (id !== run || !state) return;
    results.forEach((r, i) => !r.ok && console.warn(`search ${need.marketplaces[i]} failed: ${r.error.code} ${r.error.message}`));
    const candidates = results.flatMap((r) => (r.ok ? r.data : []));
    // Sites filter by price now, so a budget nothing meets comes back empty. Say so plainly and keep the last picks,
    // instead of reading "try different words" or the same three again.
    const keepLast = () => publish({ ...state!, phase: before.shortlist.length ? "presenting" : "idle", candidates: before.candidates, shortlist: before.shortlist, cart: before.cart, focusedProductId: before.focusedProductId });
    if (!candidates.length && need.budget && (need.budget.min || need.budget.max)) {
      keepLast();
      await say(nothingInRange(need));
      return;
    }
    if (!candidates.length) {
      publish({ ...state, phase: "idle" });
      await say("I couldn't find any products for that. Try different words.");
      return;
    }
    // B-RELEVANCE: keyword hits include near-misses ("avocado" → oil); Claude keeps real matches only.
    emit({
      stage: "shortlisting",
      message: "Checking these match what you asked for",
      at: new Date().toISOString(),
    });
    const tRel = performance.now();
    const relevant = relevance ? await relevance(need, candidates) : candidates;
    console.log(
      `relevance: ${candidates.length} → ${relevant.length} in ${Math.round(performance.now() - tRel)} ms` +
        (relevance ? "" : " (skipped)"),
    );
    if (id !== run || !state) return;
    if (!relevant.length) {
      publish({ ...state, phase: "idle", candidates });
      await say("I found listings, but none looked like what you asked for. Try different words.");
      return;
    }
    if (!relevant.some((c) => inRange(need, c))) {
      keepLast();
      await say(nothingInRange(need));
      return;
    }
    publish({ ...state, phase: "shortlisting", candidates: relevant });
    let reading = false;
    // Narrowing runs while the count is read out.
    const counted = say(
      relevant.length > 3 ? `I found ${relevant.length} products. Picking the best three.` : `I found ${relevant.length} products.`,
      "progress",
    );
    const t0 = performance.now();
    // B-REVIEWS-FIRST: ~6 finalists' pages (features + retailer reviews) are read before the final 3 are chosen.
    const narrowed = await narrowWithReviews(jev, need, relevant, (c) => {
      if (!reading) emit({ stage: "reviews", message: "Reading reviews for the top picks", at: new Date().toISOString() });
      reading = true;
      return services.navigator.getDetail(c, emit);
    });
    console.log(
      `narrow: ${relevant.length} → ${narrowed.picks.length} via ${narrowed.via}, chose from ${narrowed.chose} in ${Math.round(performance.now() - t0)} ms` +
        ` (direct ${narrowed.ms.direct} ms + reviews-first ${narrowed.ms.extra} ms)`,
    );
    await counted;
    if (id !== run || !state) return;
    const picks = narrowed.picks;
    // UX-FORMAT: names and prices of all three first, then one comparative line each as its details arrive.
    const options: Option[] = picks.map((p, i) => ({ rank: i + 1, why: p.why, product: p.candidate }));
    const ids = picks.map((p) => p.candidate.id);
    // A-SHOWPAGE: every option opens in its own tab, the first comes to the front.
    const tabs = services.navigator.openOptions ? picks.filter((p) => p.candidate.marketplace === "amazon").length : 0;
    // Also called when only finalists were on Amazon, so their pages' tabs close and only the options stay.
    if (tabs || narrowed.details.size > picks.length) void services.navigator.openOptions?.(ids, emit).catch(() => {});
    // The picks go into the session before they are named, so a follow-up that cuts the details off
    // ("is the last one really $165?") is answered from them. Details fill in below as they arrive.
    publish({
      ...state,
      candidates: relevant,
      shortlist: picks.map((p, i) => ({ rank: i + 1, product: p.candidate, whyPicked: `${p.why}. At ${p.candidate.marketplace}.` })),
      focusedProductId: picks[0]?.candidate.id,
    });
    // Details, reviews, photo and the spoken line for all three run at once, starting while the names are read; they are read in order.
    // Outside reviews come from the Apify prefetch started above (shared hit pool per query).
    const work = picks.map(({ candidate, why }, i) =>
      (async () => {
        // Finalists' pages were already read (or are still loading) while picking; never fetch twice.
        const detail = await (narrowed.details.get(candidate.id) ?? services.navigator.getDetail(candidate, emit));
        const product = detail.ok ? detail.data : candidate;
        let reviews: ShortlistItem["reviews"];
        let visual: ShortlistItem["visual"];
        if (detail.ok) {
          const synthP = (async () => {
            // Prefetched Apify hits when the token is set; otherwise collectExternal
            // (mock fixtures in tests, or a second Apify pass that shares the cache).
            const hits = await apifyHitsP;
            let external = reviewsFromHits(detail.data.id, hits);
            if (!external.length) {
              const got = await services.reviews.collectExternal(detail.data, emit);
              if (got.ok) external = got.data;
            }
            const by = external.reduce<Partial<Record<string, number>>>((acc, r) => {
              acc[r.source] = (acc[r.source] ?? 0) + 1;
              return acc;
            }, {});
            const bits = (["reddit", "youtube", "article"] as const)
              .filter((s) => by[s])
              .map((s) => (s === "article" ? "articles" : s === "youtube" ? "YouTube" : "Reddit"));
            emit({
              stage: "reviews",
              marketplace: detail.data.marketplace,
              message: bits.length
                ? usingApify
                  ? `Got Apify results from ${bits.join(", ")}`
                  : `Using outside reviews from ${bits.join(", ")}`
                : "Using retailer reviews only",
              at: new Date().toISOString(),
            });
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
        // Lands even if the user cut in, so their follow-up can use the reviews and the photo.
        if (search === searches && state) {
          const whyPicked = [why, reviews?.summary ?? `At ${candidate.marketplace}.`].filter(Boolean).join(". ");
          publish({
            ...state,
            shortlist: state.shortlist.map((item) => (item.product.id === candidate.id ? { ...item, product, reviews, visual, whyPicked } : item)),
          });
        }
        const option: Option = { rank: i + 1, why, product, reviews };
        // UX-SALES: the sale sentence comes from page fields, not the pitch model, so it is never made up.
        const line = withSale((pitch ? await pitch(need, option, options) : undefined) ?? templateLine(option, options), product);
        return line;
      })(),
    );
    // allSettled also keeps a job that fails after the user cut in from crashing the server.
    details = Promise.allSettled(work);
    await say(`${tabs ? `Opening the ${tabs === 1 ? "tab" : `${tabs} tabs`} now. ` : ""}${overview(options)}`);
    for (const [i, job] of work.entries()) {
      const line = await job;
      if (id !== run || !state) return;
      publish({ ...state, phase: i === work.length - 1 ? "presenting" : "shortlisting" });
      await say(line);
    }
    if (id !== run || !state) return;
    await say("Want to hear more about one, or should I add one to your cart?", "question");
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
    const readBack = review.data.readBack;
    const checkout = review.data;
    publish({ ...state, phase: "checkout_review", checkout });
    sink.send({ type: "checkout.confirmRequired", review: checkout });
    await say(readBack, "question");
  }

  async function rememberPreference(kind: PrefKind, value: string, evidence: string): Promise<ToolOut> {
    if (!state) return fail("No session.");
    const fact = prefFact(kind, value, evidence);
    if (typeof fact === "string") return fail(fact);
    const res = await services.prefs.upsertFact(state.userId, fact);
    if (!res.ok) {
      console.warn("remember_preference failed:", res.error.message);
      await say("I couldn't save that preference.");
      return { content: "Saving failed. The user was told." };
    }
    saved = withFact(saved, fact);
    await say(confirmLine(fact));
    return { content: "Saved and confirmed aloud." };
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

/**
 * The cap the user stated holds across follow-up searches: "premium" or "more expensive" with no amount
 * can't raise it (that moves the floor instead). It changes only when the user names a new amount.
 */
const inRange = (need: Need, c: ProductCandidate) =>
  (need.budget?.max == null || c.price.cents <= need.budget.max.cents) && (need.budget?.min == null || c.price.cents >= need.budget.min.cents);

const wholeDollars = (cents: number) => `$${cents % 100 ? (cents / 100).toFixed(2) : (cents / 100).toLocaleString("en-US")}`;

/** "I didn't find any water bottle over $2,000." Said instead of reading picks outside the budget. */
export function nothingInRange(need: Need) {
  const min = need.budget?.min?.cents;
  const max = need.budget?.max?.cents;
  const range =
    min != null && max != null ? `between ${wholeDollars(min)} and ${wholeDollars(max)}` : min != null ? `over ${wholeDollars(min)}` : `under ${wholeDollars(max ?? 0)}`;
  return `I didn't find any ${need.query} ${range}. Want to try a different price?`;
}

function searchBudget(input: { budgetMinCents?: number; budgetMaxCents?: number }, last: Need | undefined, said: string): Need["budget"] {
  const lastMax = last?.budget?.max?.cents;
  const max = input.budgetMaxCents != null && lastMax != null && !SAYS_AMOUNT.test(said) ? lastMax : input.budgetMaxCents;
  const min = input.budgetMinCents != null && (max == null || input.budgetMinCents < max) ? input.budgetMinCents : undefined;
  if (min == null && max == null) return undefined;
  return {
    ...(min != null ? { min: { cents: min, currency: "USD" as const } } : {}),
    ...(max != null ? { max: { cents: max, currency: "USD" as const } } : {}),
  };
}

/** Keyword routing's read of an answer to the questions: a dollar cap, and the rest as must-haves. */
function needFromAnswer(said: string): NeedExtra {
  const cap = said.match(/(?:under|less than|up to|below|max(?:imum)?|budget(?: is)?)\s*\$?\s*(\d+(?:\.\d+)?)|\$\s*(\d+(?:\.\d+)?)/i);
  const dollars = cap ? Number(cap[1] ?? cap[2]) : undefined;
  const rest = said.replace(cap?.[0] ?? "", "").replace(/^[\s,.]+|[\s,.]+$/g, "");
  return {
    budget: dollars != null ? { max: { cents: Math.round(dollars * 100), currency: "USD" } } : undefined,
    mustHaves: rest && !NO_PREFERENCE.test(rest) ? [rest] : undefined,
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

/** Brief roster of all options (name + price only). Used when re-listing after a filter. */
export function formatShortlistRoster(items: Pick<ShortlistItem, "rank" | "product">[]) {
  return items.map((item) => formatOptionLine(item.rank, item.product.title, item.product.price.cents)).join("\n");
}

/** Pros / Cons / Sources lines (no option header). */
export function formatProsConsSection(marketplace: Marketplace, reviews: ReviewSynthesis | undefined) {
  const lines: string[] = [];
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

/**
 * One spoken option: name + price, then Pros / Cons / Sources.
 * Kept for follow-up / tests; first pass uses present.ts overview + pitch lines.
 */
export function formatOptionBlock(item: Pick<ShortlistItem, "rank" | "product" | "reviews">) {
  const head = formatOptionLine(item.rank, item.product.title, item.product.price.cents);
  const body = formatProsConsSection(item.product.marketplace, item.reviews);
  return body ? `${head}\n${body}` : head;
}

function optionIndex(text: string): number {
  const match = text.match(/(?:option|number)\s*([123])/i);
  if (match) return Number(match[1]) - 1;
  if (/\bsecond\b/i.test(text)) return 1;
  if (/\bthird\b/i.test(text)) return 2;
  return 0;
}
