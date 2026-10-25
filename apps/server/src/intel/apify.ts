/**
 * Track D3: outside reviews via Apify's Google Search actor (Reddit, YouTube and review sites from SERP snippets).
 * Two runs per search: one for the shopper's query as soon as it is known, then one with a
 * "<product> review" query per shortlisted product, so each option gets reviews about itself.
 * The Reddit scraper actor timed out on every live run and the YouTube actor took 13-25 s, so neither is used.
 * The account allows 5 Apify runs at once: two runs plus their hedges stay under that.
 */
import { type ProductDetail, type ProductId, type RawReview } from "@visy/contracts";

const SEARCH_ACTOR = process.env.APIFY_SEARCH_ACTOR?.trim() || "apify~google-search-scraper";
const MAX_PER_SOURCE = 4;
const MAX_TOTAL = 12;
const MAX_BODY = 700;
/** Parallel shallow actors usually finish under this; override with APIFY_BUDGET_MS. */
const DEFAULT_BUDGET_MS = 25_000;
/** The per-product run doesn't hold up the reading (agent.ts waits for it briefly), so it gets longer. */
const PRODUCT_BUDGET_MS = 40_000;
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

export function hitsToReviews(productId: string, hits: ExternalHit[], tag = "apify"): RawReview[] {
  return hits.slice(0, MAX_TOTAL).map((h, i) => ({
    id: `${tag}:${h.source}:${i + 1}`,
    productId: productId as ProductId,
    source: h.source,
    url: h.url,
    title: h.title,
    body: h.body,
    untrusted: true as const,
  }));
}

/** The shopper-query Google search for articles (Reddit has its own query). */
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

async function collectHits(
  phrase: string,
  token: string,
  budgetMs: number,
  fetchImpl: ApifyFetch,
  signal?: AbortSignal,
): Promise<ExternalHit[]> {
  console.log(`[apify] Google (articles, Reddit) for "${phrase}" (budget ${budgetMs} ms)`);
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
  return hitsFromSearchItems(await hedged(serp, budgetMs));
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
 * Articles and Reddit threads for the query, from one Google run.
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

/** Bind hits to a product. `tag` keeps a product's own hits apart from the shared query pool in the review index. */
export function reviewsFromHits(productId: string, hits: ExternalHit[], tag?: string): RawReview[] {
  return hitsToReviews(productId, hits, tag);
}

/** Brand first, then the start of the title: "Sony WH-1000XM5 Wireless Noise Canceling". */
export function productPhrase(title: string, brand?: string) {
  const words = searchPhrase(title).split(/\s+/).slice(0, 5);
  const b = brand?.trim();
  if (b && !words.join(" ").toLowerCase().includes(b.toLowerCase())) words.unshift(b);
  return words.join(" ");
}

/**
 * One Google run for the shortlist, a "<product> review" query each, so every option gets reviews of itself.
 * A hit has to name the product's first word (usually the brand), which drops generic results for no-name brands.
 */
export async function prefetchProductHits(
  products: { id: string; title: string; brand?: string }[],
  opts: { token?: string; budgetMs?: number; fetchImpl?: ApifyFetch; signal?: AbortSignal } = {},
): Promise<Map<string, ExternalHit[]>> {
  const out = new Map<string, ExternalHit[]>();
  const token = opts.token ?? apifyToken();
  if (!token || !products.length) return out;
  const phrases = products.map((p) => productPhrase(p.title, p.brand));
  const queries = phrases.map((p) => `${p} review`);
  const budgetMs = opts.budgetMs ?? PRODUCT_BUDGET_MS;
  console.log(`[apify] Google per product: ${queries.map((q) => JSON.stringify(q)).join(", ")} (budget ${budgetMs} ms)`);
  const items = await hedged(
    (budget) =>
      runActor(
        SEARCH_ACTOR,
        { queries: queries.join("\n"), maxPagesPerQuery: 1, resultsPerPage: 10, languageCode: "en", countryCode: "us" },
        token,
        budget,
        opts.fetchImpl ?? fetch,
        opts.signal,
      ),
    budgetMs,
  );
  for (const raw of items) {
    const term = (raw as { searchQuery?: { term?: unknown } } | null)?.searchQuery?.term;
    const i = queries.findIndex((q) => q.toLowerCase() === String(term ?? "").toLowerCase());
    if (i < 0) continue;
    const name = phrases[i]!.split(/\s+/)[0]!.toLowerCase();
    out.set(products[i]!.id, hitsFromSearchItems([raw]).filter((h) => name.length < 3 || h.body.toLowerCase().includes(name)));
  }
  console.log(`[apify] per-product hits: ${products.map((p, i) => `${phrases[i]} ${out.get(p.id)?.length ?? 0}`).join(", ")}`);
  return out;
}

export async function collectViaApify(
  product: ProductDetail,
  opts: { token?: string; budgetMs?: number; fetchImpl?: ApifyFetch; signal?: AbortSignal } = {},
): Promise<RawReview[]> {
  const hits = (await prefetchProductHits([product], opts)).get(product.id) ?? [];
  return hitsToReviews(product.id, hits, "apify-own");
}
