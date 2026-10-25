/**
 * UX-PROGRESS: short spoken lines while a turn is still working, in place of a fixed "One moment.".
 * Wraps the agent's sink, so it sees what is said, each phase change and each progress event without more hooks in agent.ts.
 * Speaks only after ~2 s with nothing said, at most one line every 4.5 s, never the same line twice in a row,
 * and stops for the turn once anything other than a progress line is said (the real answer has started).
 */
import type { Marketplace, ProgressEvent, SessionState } from "@visy/contracts";
import type { AgentSink, SayKind } from "./agent.ts";
import type { ToolName } from "./agent-tools.ts";

export const QUIET_MS = 2000;
export const GAP_MS = 4500;
const TICK_MS = 250;
/** Rough spoken length per word, so "quiet" starts after a queued line has been heard, not when it was sent. */
const WORD_MS = 350;

export type Activity = "thinking" | "searching" | "comparing" | "product" | "reviews" | "photo" | "cart" | "checkout" | "memory" | "saving";

const LINES: Record<Exclude<Activity, "searching">, string[]> = {
  thinking: ["One sec", "Let me check", "Working on it", "Just a moment"],
  comparing: ["Comparing the top picks", "Narrowing it down", "Weighing the options"],
  product: ["Opening the product page", "Reading the product details", "Checking the details"],
  reviews: ["Reading the reviews", "Checking what reviewers say", "Going through the reviews"],
  photo: ["Looking at the photos", "Checking the product photo"],
  cart: ["Adding it to your cart", "Updating your cart", "Still adding it"],
  checkout: ["Opening your cart", "Checking the total", "Getting the total"],
  memory: ["Checking your usuals", "Looking up your usual"],
  saving: ["Saving that now", "Saving it"],
};

const TOOL: Record<ToolName, Activity> = {
  search: "searching",
  ask_shopping_questions: "thinking",
  filter_shortlist: "comparing",
  answer_about_product: "reviews",
  add_to_cart: "cart",
  confirm_checkout_total: "saving",
  recall_usual: "memory",
  remember_as_usual: "saving",
  ask_clarifying_question: "thinking",
};

const STAGE: Partial<Record<ProgressEvent["stage"], Activity>> = {
  searching: "searching",
  reading_product: "product",
  reviews: "reviews",
  vision: "photo",
  shortlisting: "comparing",
  carting: "cart",
  checkout: "checkout",
};

const PHASE: Partial<Record<SessionState["phase"], Activity>> = {
  searching: "searching",
  shortlisting: "comparing",
  qa: "reviews",
  carting: "cart",
};

const words = (text: string) => text.trim().split(/\s+/).length;
const cap = (m: string) => m[0]!.toUpperCase() + m.slice(1);

/** The lines that fit what is running, most specific first. `message` is the latest progress event's own line. */
export function linesFor(activity: Activity, stores: Marketplace[] = [], message?: string): string[] {
  if (activity === "searching") {
    const [first, ...rest] = stores.map(cap);
    return [
      first ? `Searching ${first} now` : "Searching now",
      rest.length ? `Checking ${rest.join(" and ")} too` : "",
      first ? `Still looking on ${first}` : "Still searching",
      "Gathering the results",
    ].filter(Boolean);
  }
  const lines = LINES[activity];
  return message && words(message) <= 6 && !lines.includes(message) ? [message, ...lines] : lines;
}

/** First line not heard recently; never the line just said. */
export function pickLine(lines: string[], recent: string[]): string {
  const last = recent.at(-1);
  return lines.find((l) => !recent.includes(l)) ?? lines.find((l) => l !== last) ?? lines[0]!;
}

export function activityForTool(name: string): Activity {
  return TOOL[name as ToolName] ?? "thinking";
}

/**
 * Returns a sink to hand the agent in place of `sink`, and `start(live)` for each turn.
 * `live()` false (the user interrupted) silences the turn. The handle's `tool(name)` notes the tool now running; `stop()` ends the turn.
 */
export function createProgress(sink: AgentSink, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const recent: string[] = [];
  let busyUntil = 0;
  let phase: SessionState["phase"] | undefined;
  let activity: Activity = "thinking";
  let stores: Marketplace[] = [];
  let message: string | undefined;
  let turn: { live: () => boolean; lastLineAt: number; answered: boolean; timer: ReturnType<typeof setInterval> } | null = null;

  function note(next: Activity, msg?: string) {
    activity = next;
    message = msg;
  }

  function heard(text: string, kind?: SayKind) {
    busyUntil = Math.max(busyUntil, now()) + words(text) * WORD_MS;
    if (turn && kind !== "progress") turn.answered = true;
  }

  const wrapped: AgentSink = {
    send(msg) {
      if (msg.type === "progress") {
        const a = STAGE[msg.event.stage];
        if (a === "searching" && msg.event.marketplace && !stores.includes(msg.event.marketplace)) stores.push(msg.event.marketplace);
        if (a) note(a, a === "searching" ? undefined : msg.event.message);
      } else if (msg.type === "session.snapshot" && msg.state.phase !== phase) {
        phase = msg.state.phase;
        // Snapshots repeat the phase as options fill in; only a change says something new is running.
        const a = PHASE[phase];
        if (a && a !== activity) note(a);
      }
      sink.send(msg);
    },
    say(text, kind) {
      heard(text, kind);
      return sink.say(text, kind);
    },
    stopSpeaking() {
      busyUntil = now();
      sink.stopSpeaking();
    },
    capturePage: sink.capturePage && ((o) => sink.capturePage!(o)),
  };

  function tick() {
    if (!turn || turn.answered || !turn.live()) return;
    const t = now();
    if (t - busyUntil < QUIET_MS || t - turn.lastLineAt < GAP_MS) return;
    const line = pickLine(linesFor(activity, stores, message), recent);
    turn.lastLineAt = t;
    recent.push(line);
    if (recent.length > 4) recent.shift();
    void wrapped.say(`${line}.`, "progress");
  }

  function start(live: () => boolean) {
    if (turn) clearInterval(turn.timer);
    busyUntil = Math.max(busyUntil, now());
    note("thinking");
    stores = [];
    const timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    const mine = { live, lastLineAt: -Infinity, answered: false, timer };
    turn = mine;
    return {
      tool(name: string) {
        if (turn === mine) note(activityForTool(name));
      },
      stop() {
        clearInterval(timer);
        if (turn === mine) turn = null;
      },
      tick,
    };
  }

  return { sink: wrapped, start };
}
