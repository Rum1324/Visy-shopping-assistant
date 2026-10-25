/**
 * Track D3: outside reviews via Apify's Google Search actor. Each shortlisted product gets one
 * "<product> review" search; Reddit, YouTube and review sites come from the results' snippets.
 * The Reddit scraper actor timed out on every live run and the YouTube actor took 13-25 s, so neither is used.
 */
import { type ProductDetail, type ProductId, type RawReview } from "@visy/contracts";

const SEARCH_ACTOR = process.env.APIFY_SEARCH_ACTOR?.trim() || "apify~google-search-scraper";
const MAX_PER_SOURCE = 4;
const MAX_TOTAL = 12;
const MAX_BODY = 700;
/** One Google run usually finishes in 7-12 s, sometimes 20-35 s; override with APIFY_BUDGET_MS. */
const DEFAULT_BUDGET_MS = 25_000;

export type ApifyFetch = typeof fetch;

/** Source-tagged review fragment before we bind it to a productId. */
export type ExternalHit = {
  source: Exclude<RawReview["source"], "retailer" | "forum">;
  url?: string;
  title?: string;
  body: string;
};

export function apifyToken() {
  return process.env.APIFY_TOKEN?.trim() ?? "";
}

export function externalBudgetMs() {
  const n = Number(process.env.APIFY_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_MS;
}

/** Short search phrase from a noisy marketplace title or shopper query. */
export function searchPhrase(title: string) {
  const cleaned = title
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(with|for|pack of|set of)\b.+$/i, " ")
    .split(/[,|–—•]/)[0]!
    .replace(/[^\w\s.'/&+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(/\s+/).slice(0, 8).join(" ") || title.slice(0, 60);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function sourceOf(url: string): ExternalHit["source"] | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (/(^|\.)amazon\.|(^|\.)walmart\.|(^|\.)target\./.test(host)) return null;
    if (/(^|\.)reddit\.com$/.test(host)) return "reddit";
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return "youtube";
    return "article";
  } catch {
    return null;
  }
}

type Organic = { title?: unknown; url?: unknown; link?: unknown; description?: unknown; snippet?: unknown };

function organics(item: Record<string, unknown>): Organic[] {
  const nested = item.organicResults ?? item.organic_results;
  if (Array.isArray(nested)) return nested as Organic[];
  if (typeof item.url === "string" || typeof item.link === "string") return [item as Organic];
  return [];
}

/** Map Google Search dataset items → article/reddit/youtube hits (hostname classified). */
export function hitsFromSearchItems(items: unknown[]): ExternalHit[] {
  const counts: Partial<Record<ExternalHit["source"], number>> = {};
  const out: ExternalHit[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    for (const hit of organics(raw as Record<string, unknown>)) {
      const url = String(hit.url ?? hit.link ?? "");
      const source = sourceOf(url);
      if (!source) continue;
      if ((counts[source] ?? 0) >= MAX_PER_SOURCE) continue;
      const title = String(hit.title ?? "").trim();
      const snippet = String(hit.description ?? hit.snippet ?? "").trim();
      const body = clip([title, snippet].filter(Boolean).join(". ").replace(/\s+/g, " ").trim(), MAX_BODY);
      if (body.length < 40) continue;
      counts[source] = (counts[source] ?? 0) + 1;
      out.push({ source, url, title: title || undefined, body });
      if (out.length >= MAX_TOTAL) return out;
    }
  }
  return out;
}

export function hitsToReviews(productId: string, hits: ExternalHit[]): RawReview[] {
  return hits.slice(0, MAX_TOTAL).map((h, i) => ({
    id: `apify:${h.source}:${i + 1}`,
    productId: productId as ProductId,
    source: h.source,
    url: h.url,
    title: h.title,
    body: h.body,
    untrusted: true as const,
  }));
}

async function runActor(
  actorId: string,
  input: Record<string, unknown>,
  token: string,
  budgetMs: number,
  fetchImpl: ApifyFetch,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const timeoutSec = Math.max(5, Math.ceil(budgetMs / 1000));
  const url = new URL(`https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items`);
  url.searchParams.set("timeout", String(timeoutSec));
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "40");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budgetMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const t0 = performance.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[apify] ${actorId} ${res.status} ${text.slice(0, 160)}`);
      return [];
    }
    const data = (await res.json()) as unknown;
    const items = Array.isArray(data) ? data : [];
    console.log(`[apify] ${actorId} → ${items.length} rows in ${Math.round(performance.now() - t0)} ms`);
    return items;
  } catch (e) {
    if ((e as Error).name === "AbortError") console.warn(`[apify] ${actorId} timed out after ${budgetMs} ms`);
    else console.warn(`[apify] ${actorId} ${(e as Error).message}`);
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Brand first, then the start of the title: "Sony WH-1000XM5 Wireless Noise Canceling". */
export function productPhrase(title: string, brand?: string) {
  const words = searchPhrase(title).split(/\s+/).slice(0, 5);
  const b = brand?.trim();
  if (b && !words.join(" ").toLowerCase().includes(b.toLowerCase())) words.unshift(b);
  return words.join(" ");
}

/**
 * One Google search, "<product> review", in one Apify run. Reddit, YouTube and review-site results are kept,
 * retailer pages dropped. A hit has to name the product's first word (usually the brand), which drops generic
 * results for no-name brands. Times out to [] after the budget.
 */
export async function collectViaApify(
  product: Pick<ProductDetail, "id" | "title" | "brand">,
  opts: { token?: string; budgetMs?: number; fetchImpl?: ApifyFetch; signal?: AbortSignal } = {},
): Promise<RawReview[]> {
  const token = opts.token ?? apifyToken();
  if (!token) return [];
  const phrase = productPhrase(product.title, product.brand);
  const items = await runActor(
    SEARCH_ACTOR,
    { queries: `${phrase} review`, maxPagesPerQuery: 1, resultsPerPage: 10, languageCode: "en", countryCode: "us" },
    token,
    opts.budgetMs ?? externalBudgetMs(),
    opts.fetchImpl ?? fetch,
    opts.signal,
  );
  const name = phrase.split(/\s+/)[0]!.toLowerCase();
  const hits = hitsFromSearchItems(items).filter((h) => name.length < 3 || h.body.toLowerCase().includes(name));
  return hitsToReviews(product.id, hits);
}
