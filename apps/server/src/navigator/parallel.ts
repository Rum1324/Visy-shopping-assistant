import type { MossClient } from "@moss-js/moss";
import { ok, type ElementPicker, type PageElement, type PageState, type Result } from "@visy/contracts";
import type { PlaywrightDriver } from "./driver/playwright.ts";
import { pickWithChain, type ChainPick } from "./chain.ts";
import { strictPicker, type FindStep } from "./pickers/common.ts";
import { MemoryPicker } from "./pickers/memory.ts";
import { MossPicker, mossClient } from "./pickers/moss.ts";
import { ClaudePicker } from "./pickers/claude.ts";
import { AmazonFlow, STEPS } from "./sites/amazon.ts";

/**
 * C1c: one Moss session per tab so several tabs (sites / products) run at once. Moss embeds on a native
 * worker thread, so one tab's embedding overlaps another tab's page load. All tabs share one browser
 * (PlaywrightDriver) and ONE MemoryPicker: memory persists with saveToDisk to a single dir, so its writes
 * are serialized here.
 */

/** Same client, but every session it opens gets a per-tab suffix, so tab sessions never share an index. */
export const tabClient = (client: MossClient, i: number): MossClient =>
  Object.assign(Object.create(client), {
    session: (name: string, ...rest: unknown[]) => (client.session as Function).call(client, `${name}-tab${i}`, ...rest),
  });

/** MemoryPicker whose remember() calls run one at a time (concurrent saveToDisk to one dir would race). */
export class SharedMemory extends MemoryPicker {
  private queue: Promise<unknown> = Promise.resolve();
  override remember(state: PageState, step: FindStep, el: PageElement) {
    const run = this.queue.then(() => super.remember(state, step, el));
    this.queue = run.catch(() => {});
    return run;
  }
}

export type TabStats = {
  snapshots: number;
  snapshotMs: number;
  /** Moss embedding of new element texts (indexMs). */
  embedMs: number;
  /** Time inside each picker's pick(), embedding included. */
  pickerMs: Record<string, number>;
};

/** Wraps a picker to record how long it took and how much of that was embedding. */
const timed = (p: ElementPicker, stats: () => TabStats): ElementPicker => ({
  name: p.name,
  pick: async (state, step) => {
    const t0 = performance.now();
    const r = await p.pick(state, step);
    const s = stats();
    s.pickerMs[p.name] = Math.round((s.pickerMs[p.name] ?? 0) + performance.now() - t0);
    if (r.ok && r.data.indexMs) s.embedMs = Math.round(s.embedMs + r.data.indexMs);
    return r;
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freshStats = (): TabStats => ({ snapshots: 0, snapshotMs: 0, embedMs: 0, pickerMs: {} });

export type TabReport = {
  tab: number;
  query: string;
  ok: boolean;
  error?: string;
  asin?: string;
  title?: string;
  /** What would be clicked. Never clicked here. */
  picked?: { role: string; name: string; picker: string; tried: string[] };
  ms: Record<string, number>;
  stats: TabStats;
};

/** One tab: its own AmazonFlow, MossPicker and ClaudePicker; memory and driver are shared. */
export class TabWorker {
  readonly flow: AmazonFlow;
  readonly moss?: MossPicker;
  readonly claude?: ClaudePicker;
  private pickers: ElementPicker[];
  stats = freshStats();

  constructor(
    readonly i: number,
    private driver: PlaywrightDriver,
    client: MossClient,
    private memory: MemoryPicker | undefined,
    onBlocked: () => Promise<void>,
    spec = process.env.PICKER_CHAIN ?? "memory,moss,claude",
  ) {
    const names = spec.split(",").map((s) => s.trim());
    this.moss = names.includes("moss") ? new MossPicker(tabClient(client, i)) : undefined;
    this.claude = names.includes("claude") ? new ClaudePicker() : undefined;
    const byName = { memory: names.includes("memory") ? memory : undefined, moss: this.moss, claude: this.claude } as Record<string, ElementPicker | undefined>;
    this.pickers = names
      .map((n) => byName[n])
      .filter((p): p is ElementPicker => !!p)
      .map((p) => timed(p, () => this.stats));
    this.flow = new AmazonFlow(driver, this.pickers, memory, onBlocked);
  }

  /** Loads the embedding model / session and opens this worker's tab. */
  async warm() {
    const [, tab] = await Promise.all([this.moss?.warm(), this.driver.openTab("about:blank")]);
    if (!tab.ok) throw new Error(tab.error.message);
    this.flow.tabId = tab.data.tabId;
  }

  /**
   * AmazonFlow.step without the act: snapshot → pick while the page streams, full chain once the DOM is
   * ready or the deadline passes. Used to locate Add to Cart without clicking it (keeps the real cart clean).
   */
  async locate(step: FindStep, deadlineMs = 6000): Promise<Result<ChainPick & { el: PageElement }>> {
    const tabId = this.flow.tabId!;
    const fast = this.pickers.filter((p) => p.name !== "claude").map((p) => (p.name === "moss" ? strictPicker(p) : p));
    const end = performance.now() + deadlineMs;
    while (true) {
      const ready = (await this.driver.evaluate<string>(tabId, "document.readyState").catch(() => "loading")) !== "loading";
      const t0 = performance.now();
      const s = await this.driver.snapshot(tabId);
      this.stats.snapshots++;
      this.stats.snapshotMs = Math.round(this.stats.snapshotMs + performance.now() - t0);
      if (!s.ok) {
        if (s.error.code === "blocked" || performance.now() > end) return s;
        await sleep(150);
        continue;
      }
      const final = ready || performance.now() > end;
      const pick = await pickWithChain(final ? this.pickers : fast, s.data, step, this.memory);
      if (pick.ok) return ok({ ...pick.data, el: s.data.elements.find((e) => e.idx === pick.data.idx)! });
      if (final) return pick;
      await sleep(150);
    }
  }

  /** search → open first organic result → locate Add to Cart (not clicked). */
  async run(query: string): Promise<TabReport> {
    this.stats = freshStats();
    const ms: Record<string, number> = {};
    const t0 = performance.now();
    const lap = async <T>(label: string, fn: () => Promise<T>) => {
      const t = performance.now();
      const r = await fn();
      ms[label] = Math.round(performance.now() - t);
      return r;
    };
    const report = (extra: Partial<TabReport>): TabReport => ({
      tab: this.i,
      query,
      ok: false,
      ...extra,
      ms: { ...ms, total: Math.round(performance.now() - t0) },
      stats: this.stats,
    });
    const results = await lap("search", () => this.flow.search(query));
    if (!results.ok) return report({ error: results.error.message });
    const pick = results.data.find((r) => !r.sponsored) ?? results.data[0]!;
    const opened = await lap("open", () => this.flow.open(pick.asin));
    if (!opened.ok) return report({ error: opened.error.message, asin: pick.asin });
    const found = await lap("locate", () => this.locate(STEPS.addToCart));
    if (!found.ok) return report({ error: found.error.message, asin: pick.asin, title: pick.title });
    const { el, picker, tried } = found.data;
    return report({ ok: true, asin: pick.asin, title: pick.title, picked: { role: el.role, name: el.name, picker, tried } });
  }

  async close() {
    await this.moss?.close();
  }
}

/** Runs the queries on separate tabs at once (one TabWorker each). Wall clock ≈ the slowest tab. */
export const runParallel = (workers: TabWorker[], queries: string[]) => Promise.all(queries.map((q, i) => workers[i % workers.length]!.run(q)));

/** Baseline: one worker, one tab, one query after another (what demo.ts does today). */
export async function runSequential(worker: TabWorker, queries: string[]) {
  const out: TabReport[] = [];
  for (const q of queries) out.push(await worker.run(q));
  return out;
}

/** n workers over one shared Moss client, memory and driver. */
export function buildTabs(driver: PlaywrightDriver, n: number, onBlocked: () => Promise<void>) {
  const client = mossClient();
  const memory = (process.env.PICKER_CHAIN ?? "memory,moss,claude").includes("memory") ? new SharedMemory(client) : undefined;
  const workers = Array.from({ length: n }, (_, i) => new TabWorker(i, driver, client, memory, onBlocked));
  return {
    workers,
    memory,
    close: async () => {
      await Promise.all(workers.map((w) => w.close()));
      await memory?.close();
    },
  };
}
