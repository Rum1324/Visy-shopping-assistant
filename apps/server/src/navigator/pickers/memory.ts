import type { MossClient, SessionIndex } from "@moss-js/moss";
import { err, ok, type ElementPicker, type PageElement, type PageState, type PickResult, type Result } from "@visy/contracts";
import { candidates, siteOf, type FindStep } from "./common.ts";
import { mossClient } from "./moss.ts";

const DIR = process.env.VISY_MEMORY_DIR ?? "data";
const NAME = "visy-actions";

/**
 * "Slow the first time, then indexed": remembers which element (role + name + section) worked for an intent on a site.
 * Backed by a Moss session persisted with saveToDisk, so it survives restarts with no cloud round trip.
 * A hit is trusted only if an element with the same role and name exists on the current page.
 */
export class MemoryPicker implements ElementPicker {
  readonly name = "recipe" as const;
  private session?: Promise<SessionIndex>;
  private n = 0;

  constructor(
    private client: MossClient = mossClient(),
    private minScore = Number(process.env.MEMORY_MIN_SCORE ?? 0.8),
  ) {}

  private open() {
    this.session ??= (async () => {
      const s = await this.client.session(NAME);
      this.n = await s.loadFromDisk(DIR).catch(() => 0);
      return s;
    })();
    return this.session;
  }

  async size() {
    await this.open();
    return this.n;
  }

  async pick(state: PageState, step: FindStep): Promise<Result<PickResult & { trusted: boolean }>> {
    try {
      const s = await this.open();
      if (!this.n) return err("not_found", "memory empty");
      const site = siteOf(state.url);
      const t0 = performance.now();
      const res = await s.query(`${site} ${step.intent}`, { topK: 5 });
      const latencyMs = performance.now() - t0;
      const cands = candidates(state, step);
      for (const d of res.docs) {
        if (d.score < this.minScore || d.metadata?.site !== site) continue;
        const m = d.metadata;
        const same = cands.filter((e) => e.role === m.role && e.name.toLowerCase() === m.name?.toLowerCase());
        const el = same.find((e) => (e.section ?? "") === (m.section ?? "")) ?? (same.length === 1 ? same[0] : undefined);
        if (el) return ok({ idx: el.idx, score: d.score, picker: "recipe", latencyMs, trusted: true });
      }
      return err("not_found", "no remembered element on this page");
    } catch (e) {
      return err("internal", `memory: ${(e as Error).message}`, true);
    }
  }

  /** Called after a slower picker succeeded. Persists immediately; it's tiny. */
  async remember(state: PageState, step: FindStep, el: PageElement) {
    const s = await this.open();
    const site = siteOf(state.url);
    const id = `${site}|${step.intent}`;
    const metadata: Record<string, string> = { site, role: el.role, name: el.name, intent: step.intent };
    if (el.section) metadata.section = el.section;
    const r = await s.addDocs([{ id, text: `${site} ${step.intent}`, metadata }]);
    this.n += r.added;
    await s.saveToDisk(DIR);
  }

  async close() {
    await (await this.session)?.close();
  }
}
