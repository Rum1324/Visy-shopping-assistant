/**
 * UX-PROGRESS: short spoken lines while a turn is still working ("Searching Amazon now", "Reading the reviews").
 * Wraps the agent's sink, so it sees what is said, each phase change and each progress event without more hooks in agent.ts.
 * Speaks only after ~2 s with nothing said, at most one line every 4.5 s, never the same line twice in a row, at most
 * 6 words a line, and stops for the turn once the real answer starts. Lines go out as kind "progress", so they never
 * count as an answer in the Claude loop and ws.ts skips them while other speech is playing.
 */
import type { Marketplace, ProgressEvent, SessionState } from "@visy/contracts";
import type { AgentSink, SayKind } from "./agent.ts";
import type { ToolName } from "./agent-tools.ts";

export const QUIET_MS = 2000;
export const GAP_MS = 4500;
const TICK_MS = 250;
const MAX_WORDS = 6;
/** A navigator asking the user to act (bot check, press and hold). Said at once, as is, never dropped. */
const NOTICE = /\b(bypass|captcha|bot check|press and hold)\b/i;

export type Activity =
  | "thinking"
  | "searching"
  | "comparing"
  | "product"
  | "reviews"
  | "photo"
  | "cart"
  | "checkout"
  | "memory"
  | "saving"
  | "blocked";

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
  // One line only: said once, then quiet while the user solves the check.
  blocked: ["Still waiting on the check"],
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
  remember_preference: "saving",
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
const cap = (m: string) => (m === "nearlynatural" ? "Nearly Natural" : m[0]!.toUpperCase() + m.slice(1));
const bare = (line: string) => line.trim().replace(/[.!…]+$/, "");

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
  const own = message ? bare(message) : "";
  return own && words(own) <= MAX_WORDS && !lines.includes(own) ? [own, ...lines] : lines;
}

/** First line not heard recently. Undefined when the only fitting line is the one just said. */
export function pickLine(lines: string[], recent: string[]): string | undefined {
  return lines.find((l) => !recent.includes(l)) ?? lines.find((l) => l !== recent.at(-1));
}

export function activityForTool(name: string): Activity {
  return TOOL[name as ToolName] ?? "thinking";
}

/**
 * `sink` goes to the agent in place of the real one. `during(fn)` runs one user turn with progress lines on;
 * `tool(name)` notes the Claude tool now running. `rate()` is the speech rate, for how long a queued line takes to say.
 */
export function createProgress(real: AgentSink, opts: { rate?: () => number; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const rate = opts.rate ?? (() => 1);
  const recent: string[] = [];
  const notices = new Set<string>();
  let busyUntil = 0;
  let phase: SessionState["phase"] | undefined;
  let activity: Activity = "thinking";
  let stores: Marketplace[] = [];
  let message: string | undefined;
  let turn: { lastLineAt: number; answered: boolean } | null = null;

  function note(next: Activity, msg?: string) {
    activity = next;
    message = msg;
  }

  /** Roughly when queued speech ends (~0.33 s a word at 1x plus synthesis), so quiet is counted after it is heard. */
  function heard(text: string) {
    busyUntil = Math.max(busyUntil, now()) + 400 + (words(text) * 330) / rate();
  }

  function onEvent(e: ProgressEvent) {
    if (NOTICE.test(e.message)) {
      note("blocked");
      if (!notices.has(e.message)) {
        notices.add(e.message);
        heard(e.message);
        void real.say(e.message, "answer");
      }
      return;
    }
    const a = STAGE[e.stage];
    if (a === "searching" && e.marketplace && !stores.includes(e.marketplace)) stores.push(e.marketplace);
    if (a) note(a, a === "searching" ? undefined : e.message);
  }

  const sink: AgentSink = {
    send(msg) {
      if (msg.type === "progress") onEvent(msg.event);
      else if (msg.type === "session.snapshot" && msg.state.phase !== phase) {
        phase = msg.state.phase;
        // Snapshots repeat the phase as options fill in; only a change says something new is running.
        const a = PHASE[phase];
        if (a && a !== activity) note(a);
      }
      real.send(msg);
    },
    say(text, kind?: SayKind) {
      heard(text);
      // "I'll check Amazon …" opens a search; anything else that is not progress is the real answer.
      if (turn && kind !== "progress" && phase !== "searching") turn.answered = true;
      return real.say(text, kind);
    },
    stopSpeaking() {
      busyUntil = now();
      // Interrupted: this turn has nothing more worth saying.
      if (turn) turn.answered = true;
      real.stopSpeaking();
    },
    capturePage: real.capturePage && ((o) => real.capturePage!(o)),
  };

  function tick() {
    if (!turn || turn.answered) return;
    const t = now();
    if (t - busyUntil < QUIET_MS || t - turn.lastLineAt < GAP_MS) return;
    const line = pickLine(linesFor(activity, stores, message), recent);
    if (!line) return;
    turn.lastLineAt = t;
    recent.push(line);
    if (recent.length > 4) recent.shift();
    void sink.say(`${line}.`, "progress");
  }

  async function during<T>(fn: () => Promise<T>): Promise<T> {
    const mine = { lastLineAt: -Infinity, answered: false };
    turn = mine;
    busyUntil = Math.max(busyUntil, now());
    note("thinking");
    stores = [];
    notices.clear();
    const timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(timer);
      if (turn === mine) turn = null;
    }
  }

  return {
    sink,
    during,
    tool(name: string) {
      if (turn) note(activityForTool(name));
    },
    /** For tests: run one check now instead of waiting for the timer. */
    tick,
  };
}
