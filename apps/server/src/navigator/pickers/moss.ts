import { MossClient, type SessionIndex } from "@moss-js/moss";
import { err, ok, type ElementPicker, type PageState, type PickResult, type Result } from "@visy/contracts";
import { candidates, elementDoc, type FindStep } from "./common.ts";

export const mossClient = () => {
  const id = process.env.MOSS_PROJECT_ID;
  const key = process.env.MOSS_PROJECT_KEY;
  if (!id || !key) throw new Error("MOSS_PROJECT_ID / MOSS_PROJECT_KEY missing (apps/server/.env)");
  return new MossClient(id, key);
};

/**
 * Per-page local Moss session over the indexed elements. Trusted when the top hit beats the runner-up by MOSS_GAP.
 * Sessions are cached per page snapshot, so several steps on the same page pay indexing once.
 */
export class MossPicker implements ElementPicker {
  readonly name = "moss" as const;
  private cache = new Map<string, Promise<SessionIndex>>();
  private seq = 0;

  constructor(
    private client = mossClient(),
    private gap = Number(process.env.MOSS_GAP ?? 0.08),
  ) {}

  private key(state: PageState) {
    return `${state.tabId}:${state.url}:${state.fingerprint}:${state.capturedAt}`;
  }

  /** Builds (or reuses) the session for this snapshot. Returns indexMs = 0 on cache hits. */
  async index(state: PageState): Promise<{ session: SessionIndex; indexMs: number }> {
    const k = this.key(state);
    const hit = this.cache.get(k);
    if (hit) return { session: await hit, indexMs: 0 };
    const t0 = performance.now();
    const p = (async () => {
      const s = await this.client.session(`visy-page-${process.pid}-${this.seq++}`);
      await s.addDocs(state.elements.filter((e) => !e.purchaseRisk).map((e) => ({ id: String(e.idx), text: elementDoc(e) })));
      return s;
    })();
    this.cache.set(k, p);
    const session = await p;
    // Keep memory bounded: drop the oldest sessions.
    while (this.cache.size > 8) {
      const [oldKey, old] = this.cache.entries().next().value!;
      this.cache.delete(oldKey);
      old.then((s) => s.close()).catch(() => {});
    }
    return { session, indexMs: performance.now() - t0 };
  }

  async pick(state: PageState, step: FindStep): Promise<Result<PickResult & { trusted: boolean }>> {
    try {
      const allowed = new Set(candidates(state, step).map((e) => e.idx));
      if (!allowed.size) return err("not_found", "no candidate elements");
      const { session, indexMs } = await this.index(state);
      const t0 = performance.now();
      const res = await session.query(step.intent, { topK: 10 });
      const latencyMs = performance.now() - t0;
      const docs = res.docs.filter((d) => allowed.has(Number(d.id)));
      const top = docs[0];
      if (!top) return err("low_confidence", "moss found nothing");
      const runnerUpScore = Math.max(0, ...docs.slice(1).map((d) => d.score));
      return ok({
        idx: Number(top.id),
        score: top.score,
        runnerUpScore,
        picker: "moss",
        latencyMs,
        indexMs,
        trusted: top.score - runnerUpScore >= this.gap,
      });
    } catch (e) {
      return err("internal", `moss: ${(e as Error).message}`, true);
    }
  }

  async close() {
    for (const p of this.cache.values()) await p.then((s) => s.close()).catch(() => {});
    this.cache.clear();
  }
}
