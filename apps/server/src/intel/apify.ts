/**
 * Track D3: outside reviews via Apify (Reddit + YouTube + article SERP), in parallel.
 * Dedicated full-page scrapers are richer but colder/slower; we use shallow search actors
 * and SERP snippets so Claude still gets multi-source text inside the time budget.
 * Reddit comes from a site:reddit.com Google query: the Reddit scraper actor timed out on every live run.
 */
import { type ProductDetail, type ProductId, type RawReview } from "@visy/contracts";

const YOUTUBE_ACTOR = process.env.APIFY_YOUTUBE_ACTOR?.trim() || "streamers~youtube-scraper";
const SEARCH_ACTOR = process.env.APIFY_SEARCH_ACTOR?.trim() || "apify~google-search-scraper";
const MAX_PER_SOURCE = 4;
const MAX_TOTAL = 12;
const MAX_BODY = 700;
/** Parallel shallow actors usually finish under this; override with APIFY_BUDGET_MS. */
const DEFAULT_BUDGET_MS = 25_000;
const CACHE_MS = 10 * 60_000;
/** Google runs usually finish in 3-8 s but about a third hang until the budget; a second run started this late often wins. */
const HEDGE_MS = 10_000;

export type ApifyFetch = typeof fetch;

/** Source-tagged review fragment before we bind it to a productId. */
export type ExternalHit = {
  source: Exclude<RawReview["source"], "retailer" | "forum">;
  url?: string;
  title?: string;
  body: string;
};

const cache = new Map<string, { at: number; hits: ExternalHit[] }>();
const inflight = new Map<string, Promise<ExternalHit[]>>();

export function resetApifyCache() {
  cache.clear();
  inflight.clear();
}

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

/** Keywords from the shopper need (query + a couple must-haves). */
export function reviewKeywords(query: string, mustHaves: string[] = []) {
  const extra = mustHaves.slice(0, 2).join(" ");
  return searchPhrase([query, extra].filter(Boolean).join(" "));
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

/** @deprecated alias for tests that still map SERP → RawReview directly */
export function reviewsFromSearchItems(productId: string, items: unknown[]): RawReview[] {
  return hitsToReviews(productId, hitsFromSearchItems(items));
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

/** One Google query used only for article discovery (Reddit has its own query, YouTube its own actor). */
export function buildQueries(phrase: string) {
  const q = phrase.replace(/"/g, "");
  return `"${q}" review -site:amazon.com -site:walmart.com -site:target.com -site:reddit.com -site:youtube.com -site:youtu.be`;
}

/** Reddit threads through Google, unquoted so a long phrase still matches thread titles. */
export function redditQuery(phrase: string) {
  return `${phrase.replace(/"/g, "")} site:reddit.com`;
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

function hitsFromYoutube(items: unknown[]): ExternalHit[] {
  const out: ExternalHit[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = String(r.title ?? "").trim();
    const desc = String(r.description ?? r.text ?? "").trim();
    const url = String(r.url ?? r.parsedUrl ?? (r.id ? `https://www.youtube.com/watch?v=${r.id}` : ""));
    // Prefer caption/transcript fields when the actor returns them; else title+description.
    const transcript = String(r.transcript ?? r.subtitles ?? r.captionText ?? "").trim();
    const body = clip((transcript || [title, desc].filter(Boolean).join(". ")).replace(/\s+/g, " ").trim(), MAX_BODY);
    if (body.length < 40) continue;
    out.push({ source: "youtube", url: url || undefined, title: title || undefined, body });
    if (out.length >= MAX_PER_SOURCE) break;
  }
  return out;
}

async function collectHits(
  phrase: string,
  token: string,
  budgetMs: number,
  fetchImpl: ApifyFetch,
  signal?: AbortSignal,
): Promise<ExternalHit[]> {
  const q = `${phrase} review`;
  console.log(`[apify] parallel YouTube + Google (articles, Reddit) for "${phrase}" (budget ${budgetMs} ms)`);
  const serp = (budget: number) =>
    runActor(
      SEARCH_ACTOR,
      {
        // One run, one results page per line.
        queries: [buildQueries(phrase), redditQuery(phrase)].join("\n"),
        maxPagesPerQuery: 1,
        resultsPerPage: 8,
        languageCode: "en",
        countryCode: "us",
      },
      token,
      budget,
      fetchImpl,
      signal,
    );
  const [ytItems, serpItems] = await Promise.all([
    runActor(
      YOUTUBE_ACTOR,
      {
        searchQueries: [q],
        maxResults: 4,
        maxResultsShorts: 0,
        maxResultStreams: 0,
      },
      token,
      budgetMs,
      fetchImpl,
      signal,
    ),
    hedged(serp, budgetMs),
  ]);
  const hits = [...hitsFromYoutube(ytItems), ...hitsFromSearchItems(serpItems).filter((h) => h.source !== "youtube")];
  // Prefer diversity: cap total after merge.
  const counts: Partial<Record<ExternalHit["source"], number>> = {};
  const mixed: ExternalHit[] = [];
  for (const h of hits) {
    if ((counts[h.source] ?? 0) >= MAX_PER_SOURCE) continue;
    counts[h.source] = (counts[h.source] ?? 0) + 1;
    mixed.push(h);
    if (mixed.length >= MAX_TOTAL) break;
  }
  return mixed;
}

/** Starts a second run after HEDGE_MS if the first hasn't returned rows; the first run with rows wins. */
function hedged(run: (budgetMs: number) => Promise<unknown[]>, budgetMs: number): Promise<unknown[]> {
  if (budgetMs < HEDGE_MS + 5_000) return run(budgetMs);
  return new Promise((resolve) => {
    let left = 2;
    const done = (items: unknown[]) => {
      left--;
      if (items.length || !left) {
        clearTimeout(timer);
        resolve(items);
      }
    };
    run(budgetMs).then(done);
    const timer = setTimeout(() => {
      console.log(`[apify] Google still running after ${HEDGE_MS} ms, starting a second run`);
      run(budgetMs - HEDGE_MS).then(done);
    }, HEDGE_MS);
  });
}

/**
 * Start outside-review fetch as soon as we know the shopper keywords.
 * Reddit + YouTube + article SERP run in parallel under one budget.
 */
export function prefetchApifySearch(
  query: string,
  opts: { token?: string; budgetMs?: number; fetchImpl?: ApifyFetch; signal?: AbortSignal; mustHaves?: string[] } = {},
): Promise<ExternalHit[]> {
  const token = opts.token ?? apifyToken();
  if (!token) return Promise.resolve([]);
  const phrase = reviewKeywords(query, opts.mustHaves);
  const cached = cache.get(phrase);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    console.log(`[apify] cache hit for "${phrase}" (${cached.hits.length} hits)`);
    return Promise.resolve(cached.hits);
  }
  const pending = inflight.get(phrase);
  if (pending) {
    console.log(`[apify] joining in-flight search for "${phrase}"`);
    return pending;
  }
  const budgetMs = opts.budgetMs ?? externalBudgetMs();
  const run = collectHits(phrase, token, budgetMs, opts.fetchImpl ?? fetch, opts.signal)
    .then((hits) => {
      cache.set(phrase, { at: Date.now(), hits });
      console.log(`[apify] ${hits.length} outside hits for "${phrase}"`);
      return hits;
    })
    .finally(() => inflight.delete(phrase));
  inflight.set(phrase, run);
  return run;
}

/** Bind prefetched hits to a product (same outside pool for each shortlist option). */
export function reviewsFromHits(productId: string, hits: ExternalHit[]): RawReview[] {
  return hitsToReviews(productId, hits);
}

export async function collectViaApify(
  product: ProductDetail,
  opts: { token?: string; budgetMs?: number; fetchImpl?: ApifyFetch; signal?: AbortSignal } = {},
): Promise<RawReview[]> {
  const hits = await prefetchApifySearch(product.title, opts);
  return hitsToReviews(product.id, hits);
}
