import { createHash } from "node:crypto";
import type { MossClient, SessionIndex } from "@moss-js/moss";
import { err, ok, type ProductId, type RawReview, type Result, type ReviewIndex } from "@visy/contracts";
import { mossClient } from "../navigator/pickers/moss.ts";

const CHUNK = 800;

/** Splits long review bodies at ~800 chars, preferring sentence ends. */
const chunks = (text: string): string[] => {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > CHUNK) {
    const cut = rest.lastIndexOf(". ", CHUNK);
    const at = cut > CHUNK / 2 ? cut + 1 : CHUNK;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
};

/** Reviews that talk to AI tools never become a spoken Q&A answer. Synthesis still sees them and warns. */
export const looksLikeInjection = (text: string) =>
  /\b(ignore|disregard|forget)\b.{0,30}\b(instructions|prompt|rules)\b|\bsystem prompt\b|\badd \d+ to (the |your )?cart\b/i.test(text);

const key = (productId: string, reviewId: string) =>
  createHash("sha1").update(`${productId}\u0000${reviewId}`).digest("hex").slice(0, 16);

/**
 * Track D: retrieval over the shortlist's reviews, backed by one long-lived local Moss session shared by
 * every product. Review text is untrusted data: it is embedded and returned verbatim, never interpreted.
 */
export class MossReviewIndex implements ReviewIndex {
  private session?: Promise<SessionIndex>;
  /** review key → { review, doc ids }. Doc ids are `${key}:${chunk}`. */
  private reviews = new Map<string, { review: RawReview; docIds: string[] }>();
  /** productId → review keys. */
  private byProduct = new Map<string, Set<string>>();

  constructor(
    private client: MossClient = mossClient(),
    /**
     * Hybrid weight: 1 = semantic only, 0 = keyword (BM25) only. Anything ≤ 0.9 lets one stray keyword win
     * ("without looking?" → "colors look darker"); 0.95 ranked like pure semantic on our sweeps (top-3 12/12
     * on 15 reviews) while keeping a little keyword pull for exact terms like model names.
     */
    public alpha = Number(process.env.MOSS_REVIEW_ALPHA ?? 0.95),
  ) {}

  /** Call once at startup: the first session loads the embedding model (~7 s). */
  warm() {
    this.session ??= this.client.session(`visy-reviews-${process.pid}`);
    return this.session;
  }

  async index(productId: ProductId, reviews: RawReview[]): Promise<Result<{ chunks: number }>> {
    try {
      const session = await this.warm();
      const docs: { id: string; text: string; metadata: Record<string, string> }[] = [];
      const stale: string[] = [];
      const keys = this.byProduct.get(productId) ?? new Set<string>();
      for (const r of reviews) {
        if (looksLikeInjection(`${r.title ?? ""} ${r.body}`)) continue;
        const k = key(productId, r.id);
        const text = [r.title, r.body].filter(Boolean).join(". ");
        const parts = chunks(text);
        const docIds = parts.map((_, i) => `${k}:${i}`);
        const prev = this.reviews.get(k);
        if (prev) stale.push(...prev.docIds.filter((id) => !docIds.includes(id)));
        parts.forEach((t, i) => docs.push({ id: docIds[i]!, text: t, metadata: { productId } }));
        this.reviews.set(k, { review: { ...r, productId }, docIds });
        keys.add(k);
      }
      this.byProduct.set(productId, keys);
      if (stale.length) await session.deleteDocs(stale);
      if (docs.length) await session.addDocs(docs, { upsert: true });
      return ok({ chunks: docs.length });
    } catch (e) {
      return err("internal", `moss reviews: ${(e as Error).message}`, true);
    }
  }

  async search(productId: ProductId, query: string, k = 5): Promise<Result<RawReview[]>> {
    try {
      const keys = this.byProduct.get(productId);
      if (!keys?.size || !query.trim()) return ok([]);
      const session = await this.warm();
      // The session holds every product's reviews: over-fetch, then keep this product's hits.
      const total = [...keys].reduce((n, key) => n + (this.reviews.get(key)?.docIds.length ?? 0), 0);
      const res = await session.query(query, {
        topK: Math.max(50, total * 2),
        alpha: this.alpha,
        filter: { field: "productId", condition: { $eq: productId } },
      });
      const out: RawReview[] = [];
      const seen = new Set<string>();
      for (const d of res.docs) {
        const rk = d.id.split(":")[0]!;
        if (seen.has(rk) || !keys.has(rk)) continue;
        const hit = this.reviews.get(rk);
        if (!hit || hit.review.productId !== productId) continue;
        seen.add(rk);
        out.push(hit.review);
        if (out.length >= k) break;
      }
      return ok(out);
    } catch (e) {
      return err("internal", `moss reviews: ${(e as Error).message}`, true);
    }
  }

  async close() {
    await (await this.session)?.close().catch(() => {});
    this.session = undefined;
    this.reviews.clear();
    this.byProduct.clear();
  }
}

export const mossReviewIndex = (client: MossClient = mossClient()) => new MossReviewIndex(client);
