import { createHash } from "node:crypto";
import { MossClient, type SessionIndex } from "@moss-js/moss";
import { err, ok, type ElementPicker, type PageState, type PickResult, type Result } from "@visy/contracts";
import { candidates, elementDoc, type FindStep } from "./common.ts";

export const mossClient = () => {
  const id = process.env.MOSS_PROJECT_ID;
  const key = process.env.MOSS_PROJECT_KEY;
  if (!id || !key) throw new Error("MOSS_PROJECT_ID / MOSS_PROJECT_KEY missing (apps/server/.env)");
  return new MossClient(id, key);
};

const docId = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);

/**
 * Element matching with one long-lived local Moss session shared by every page.
 * Embedding is the slow part (~1.5 ms/element), so each element text is embedded once: nav bars, buy boxes
 * and footers repeat across pages and cost nothing after the first visit. Results are mapped back to the
 * current page by text. Trusted when the top hit beats the runner-up by MOSS_GAP (tuned with the bench).
 */
export class MossPicker implements ElementPicker {
  readonly name = "moss" as const;
  private session?: Promise<SessionIndex>;
  private known = new Set<string>();

  constructor(
    private client = mossClient(),
    private gap = Number(process.env.MOSS_GAP ?? 0.1),
    /** Hybrid weight: 1 = semantic only, 0 = keyword (BM25) only. Bench winner: 0.2. */
    public alpha = Number(process.env.MOSS_ALPHA ?? 0.2),
    /** Only the first N elements (viewport first) are indexed per page. Bench targets all sit at idx ≤ 101. */
    private maxPerPage = Number(process.env.MOSS_MAX_ELEMENTS ?? 150),
  ) {}

  /** Call once at startup: the first session loads the embedding model (~7 s). */
  warm() {
    this.session ??= this.client.session(`visy-elements-${process.pid}`);
    return this.session;
  }

  /** Embeds this page's element texts that haven't been seen before. Returns how long that took. */
  async index(state: PageState): Promise<{ session: SessionIndex; indexMs: number }> {
    const session = await this.warm();
    const t0 = performance.now();
    const fresh = new Map<string, string>();
    for (const e of state.elements.slice(0, this.maxPerPage)) {
      if (e.purchaseRisk) continue;
      const text = elementDoc(e);
      const id = docId(text);
      if (!this.known.has(id)) fresh.set(id, text);
    }
    if (fresh.size) {
      await session.addDocs([...fresh].map(([id, text]) => ({ id, text })));
      for (const id of fresh.keys()) this.known.add(id);
    }
    return { session, indexMs: fresh.size ? performance.now() - t0 : 0 };
  }

  async pick(state: PageState, step: FindStep): Promise<Result<PickResult & { trusted: boolean }>> {
    try {
      const byDoc = new Map<string, number>(); // doc id → first allowed element on this page
      for (const e of candidates(state, step).slice(0, this.maxPerPage)) {
        const id = docId(elementDoc(e));
        if (!byDoc.has(id)) byDoc.set(id, e.idx);
      }
      if (!byDoc.size) return err("not_found", "no candidate elements");
      const { session, indexMs } = await this.index(state);
      const t0 = performance.now();
      const res = await session.query(step.intent, { topK: 100, alpha: this.alpha });
      const latencyMs = performance.now() - t0;
      const docs = res.docs.filter((d) => byDoc.has(d.id));
      const top = docs[0];
      if (!top) return err("low_confidence", "moss found nothing on this page");
      const runnerUpScore = Math.max(0, ...docs.slice(1).map((d) => d.score));
      return ok({
        idx: byDoc.get(top.id)!,
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
    await (await this.session)?.close().catch(() => {});
    this.session = undefined;
    this.known.clear();
  }
}
