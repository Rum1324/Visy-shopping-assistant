/**
 * Track D3: outside reviews via Apify after the shortlist is known (background; does not block spoken pitches).
 * Google Search Scraper finds Reddit/YouTube/article SERP per option; then a bounded Reddit thread scrape
 * deepens the top few Reddit URLs (post + comments); then YouTube enrich. Stay under 5 concurrent runs.
 */
import { type ProductDetail, type ProductId, type RawReview } from "@visy/contracts";

const SEARCH_ACTOR = process.env.APIFY_SEARCH_ACTOR?.trim() || "apify~google-search-scraper";
const YOUTUBE_ACTOR = process.env.APIFY_YOUTUBE_ACTOR?.trim() || "streamers~youtube-scraper";
const REDDIT_ACTOR = process.env.APIFY_REDDIT_ACTOR?.trim() || "trudax~reddit-scraper-lite";
const MAX_PER_SOURCE = 5;
const MAX_TOTAL = 15;
const MAX_BODY = 900;
/** Shopper-query Google run; override with APIFY_BUDGET_MS. */
const DEFAULT_BUDGET_MS = 60_000;
/** Per-shortlist Google run (background); override with APIFY_PRODUCT_BUDGET_MS. */
const DEFAULT_PRODUCT_BUDGET_MS = 90_000;
/** Bounded Reddit thread deepen after Google; override with APIFY_REDDIT_BUDGET_MS. */
const DEFAULT_REDDIT_BUDGET_MS = 25_000;
const REDDIT_URLS_PER_PRODUCT = 2;
const REDDIT_URLS_TOTAL = 6;
const REDDIT_MAX_COMMENTS = 25;
const CACHE_MS = 10 * 60_000;
/** Google runs usually finish in 3-8 s but about a third hang until the budget; a second run started this late often wins. */
const HEDGE_MS = 12_000;

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

export function productBudgetMs() {
  const n = Number(process.env.APIFY_PRODUCT_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PRODUCT_BUDGET_MS;
}

export function redditBudgetMs() {
  const n = Number(process.env.APIFY_REDDIT_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REDDIT_BUDGET_MS;
}

/** Reddit post id from a comments URL, for matching Google hits to thread scrape rows. */
export function redditPostKey(url: string): string | null {
  const m = url.match(/reddit\.com\/r\/[^/]+\/comments\/([a-z0-9]+)/i);
  return m ? m[1]!.toLowerCase() : null;
}

/** Top Reddit thread URLs already discovered via Google SERP. */
export function pickRedditUrls(hits: ExternalHit[], limit = REDDIT_URLS_PER_PRODUCT): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (h.source !== "reddit" || !h.url) continue;
    const key = redditPostKey(h.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h.url.replace(/\?.*$/, "").replace(/\/$/, ""));
    if (out.length >= limit) break;
  }
  return out;
}

/** Drop Amazon Renewed / Sponsored / Choice badges so Apify doesn't search for the badge. */
function stripListingBadges(title: string) {
  let t = title.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const next = t
      .replace(
        /^(Amazon Renewed|Sponsored(?:\s+Ad)?|Best Seller|Overall Pick|Amazon'?s Choice|Climate Pledge Friendly|Limited time deal)\s*[:\-–—|]*\s*/i,
        "",
      )
      .trim();
    if (next === t) break;
    t = next;
  }
  return t || title.replace(/\s+/g, " ").trim();
}

/** Short search phrase from a noisy marketplace title or shopper query. */
export function searchPhrase(title: string) {
  const cleaned = stripListingBadges(title)
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(with|for|pack of|set of)\b.+$/i, " ")
    .split(/[,|–—•]/)[0]!
    .replace(/[^\w\s.'/&+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(/\s+/).slice(0, 8).join(" ") || stripListingBadges(title).slice(0, 60);
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
function hedged(
  run: (budgetMs: number) => Promise<unknown[]>,
  budgetMs: number,
  enabled = true,
): Promise<unknown[]> {
  // Parallel shortlist scrapes must stay under Apify's ~5 concurrent-run cap; hedging would double them.
  if (!enabled || budgetMs < HEDGE_MS + 5_000) return run(budgetMs);
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

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Distinctive model fingerprints from a listing title (e.g. "rtx 5060 ti", "wh-1000xm5").
 * Used to drop Apify hits that only mention the brand / a sibling SKU.
 */
export function modelKeys(title: string, brand?: string): string[] {
  const raw = stripListingBadges(title);
  const keys = new Set<string>();
  const add = (s: string) => {
    const n = norm(s);
    if (n.length >= 4) keys.add(n);
  };

  for (const m of raw.matchAll(
    /\b((?:geforce\s+)?(?:rtx|gtx)\s*\d{3,4}(?:\s*ti|\s*super)?|(?:radeon\s+)?rx\s*\d{3,4}(?:\s*xt)?)\b/gi,
  )) {
    const full = m[1]!.replace(/\s+/g, " ");
    add(full);
    add(full.replace(/^(geforce|radeon)\s+/i, ""));
  }

  for (const m of raw.matchAll(/\b([A-Za-z]{1,5}-?\d{2,5}[A-Za-z0-9-]{0,12})\b/g)) {
    const code = m[1]!;
    if (/^(AMD|USB|RGB|DDR|GDDR|HDMI|PCIE?)$/i.test(code)) continue;
    if (!/\d/.test(code)) continue;
    add(code);
  }

  // "5060 Ti" / "9060 XT" when the GPU family word was missed
  for (const m of raw.matchAll(/\b(\d{3,4}\s*(?:Ti|XT|Super))\b/gi)) add(m[1]!);

  void brand;
  return [...keys].sort((a, b) => b.length - a.length);
}

/** True when the SERP/snippet text is about this exact model (not just the brand). */
export function hitMatchesProduct(text: string, title: string, brand?: string): boolean {
  const hay = norm(`${text}`);
  const keys = modelKeys(title, brand);
  if (keys.length) {
    if (!keys.some((k) => hay.includes(k))) return false;
    // "rtx 5060" is a substring of "rtx 5060 ti" — reject Ti/Super hits for a non-Ti product.
    for (const k of keys) {
      const bare = k.match(/^(rtx|gtx|rx)\s*(\d{3,4})$/);
      if (!bare) continue;
      if (keys.some((x) => /\b(ti|super|xt)\b/.test(x))) continue;
      if (new RegExp(`\\b${bare[2]}\\s*(ti|super|xt)\\b`, "i").test(hay)) return false;
    }
    return true;
  }
  // Soft goods with no model code: need two content words from the phrase (avoids brand-only hits).
  const stop = new Set(["with", "and", "the", "for", "in", "a", "an", "of", "to", "by", "pack"]);
  const phrase = productPhrase(title, brand)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  if (!phrase.length) return true;
  const hits = phrase.filter((w) => hay.includes(w)).length;
  return hits >= Math.min(2, phrase.length);
}

/** Prefer "rtx 5060 ti" over longer "geforce rtx 5060 ti" for tighter quoted searches. */
export function preferredModelKey(keys: string[]) {
  return (
    keys.find((k) => /^(rtx|gtx|rx)\b/.test(k)) ??
    keys.find((k) => /\d/.test(k) && !/^(geforce|radeon)\b/.test(k)) ??
    keys[0]!
  );
}

/** Brand + model when we can; else the start of the cleaned title. */
export function productPhrase(title: string, brand?: string) {
  const keys = modelKeys(title, brand);
  if (keys.length) {
    const model = preferredModelKey(keys);
    const brandWord = (brand?.trim() || searchPhrase(title).split(/\s+/)[0] || "").split(/\s+/)[0] || "";
    if (brandWord && !model.includes(norm(brandWord))) return `${brandWord} ${model}`.replace(/\s+/g, " ");
    return model;
  }
  const words = searchPhrase(title).split(/\s+/).slice(0, 5);
  const b = brand?.trim();
  if (b && !words.join(" ").toLowerCase().includes(b.toLowerCase())) words.unshift(b);
  return words.join(" ");
}

/** Brand loose + model quoted (ASUS "rtx 5060"), or the whole phrase quoted for soft goods. */
export function searchHead(phrase: string, modelKey?: string) {
  const clean = phrase.replace(/"/g, "").trim();
  const key = modelKey?.replace(/"/g, "").trim();
  if (!key) return `"${clean}"`;
  const re = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  const brandPart = clean.replace(re, " ").replace(/\s+/g, " ").trim();
  return brandPart ? `${brandPart} "${key}"` : `"${key}"`;
}

/**
 * Three Google lines per product. Quote only the model fingerprint (e.g. ASUS "rtx 5060"), not the
 * whole brand+model string — `"ASUS rtx 5060"` misses real titles like "ASUS Dual GeForce RTX 5060".
 */
export function productExternalQueries(phrase: string, modelKey?: string) {
  const head = searchHead(phrase, modelKey);
  return [
    `${head} review site:reddit.com`,
    `${head} review site:youtube.com OR site:youtu.be`,
    `${head} review -site:amazon.com -site:walmart.com -site:target.com -site:reddit.com -site:youtube.com -site:youtu.be`,
  ];
}

function hitsFromYoutube(items: unknown[]): ExternalHit[] {
  const out: ExternalHit[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = String(r.title ?? "").trim();
    const desc = String(r.description ?? r.text ?? "").trim();
    const url = String(r.url ?? r.parsedUrl ?? (r.id ? `https://www.youtube.com/watch?v=${r.id}` : ""));
    const transcript = String(r.transcript ?? r.subtitles ?? r.captionText ?? "").trim();
    const body = clip((transcript || [title, desc].filter(Boolean).join(". ")).replace(/\s+/g, " ").trim(), MAX_BODY);
    if (body.length < 40) continue;
    out.push({ source: "youtube", url: url || undefined, title: title || undefined, body });
    if (out.length >= MAX_PER_SOURCE) break;
  }
  return out;
}

type RedditBucket = {
  productId: string;
  url: string;
  title?: string;
  post: string;
  comments: string[];
};

/**
 * Map trudax/reddit-scraper-lite (and similar) rows → one hit per thread: post body + top comments.
 * `urlToProduct` keys are reddit post ids from `redditPostKey`.
 */
export function hitsFromReddit(items: unknown[], urlToProduct: Map<string, string>): ExternalHit[] {
  const buckets = new Map<string, RedditBucket>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const url = String(r.url ?? r.postUrl ?? r.link ?? "").trim();
    const parentUrl = String(r.postUrl ?? r.parsedUrl ?? r.url ?? "").trim();
    const key = redditPostKey(url) ?? redditPostKey(parentUrl);
    if (!key) continue;
    const productId = urlToProduct.get(key);
    if (!productId) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { productId, url: url || parentUrl, title: undefined, post: "", comments: [] };
      buckets.set(key, bucket);
    }
    const dataType = String(r.dataType ?? r.type ?? r.kind ?? "").toLowerCase();
    const title = String(r.title ?? "").trim();
    const text = String(r.body ?? r.text ?? r.selftext ?? r.commentBody ?? "").trim();
    const isComment =
      dataType === "comment" ||
      (!title && !!text && /\/comment\//i.test(url)) ||
      (Boolean(r.parentId) && !title);
    if (isComment) {
      if (text.length >= 20) bucket.comments.push(text);
      continue;
    }
    if (title) bucket.title = bucket.title || title;
    if (text) bucket.post = bucket.post || text;
    else if (title && !bucket.post) bucket.post = title;
    if (url.includes("/comments/")) bucket.url = url.replace(/\?.*$/, "");
  }
  const out: ExternalHit[] = [];
  for (const b of buckets.values()) {
    const parts = [b.title, b.post, ...b.comments.slice(0, REDDIT_MAX_COMMENTS)].filter(Boolean);
    const body = clip(parts.join(". ").replace(/\s+/g, " ").trim(), MAX_BODY);
    if (body.length < 40) continue;
    out.push({ source: "reddit", url: b.url || undefined, title: b.title, body });
  }
  return out;
}

function mergeHits(into: ExternalHit[], extra: ExternalHit[]) {
  const counts: Partial<Record<ExternalHit["source"], number>> = {};
  for (const h of into) counts[h.source] = (counts[h.source] ?? 0) + 1;
  for (const h of extra) {
    if ((counts[h.source] ?? 0) >= MAX_PER_SOURCE) continue;
    counts[h.source] = (counts[h.source] ?? 0) + 1;
    into.push(h);
    if (into.length >= MAX_TOTAL) break;
  }
  return into;
}

export type PrefetchProductOpts = {
  token?: string;
  budgetMs?: number;
  fetchImpl?: ApifyFetch;
  signal?: AbortSignal;
  /** When false, skip the slow YouTube actor (Google SERP still covers youtube.com links). Default true. */
  youtube?: boolean;
  /** Duplicate Google run if the first is slow. Default true; turn off when scraping several options in parallel. */
  hedge?: boolean;
  /** Fires as soon as the Google run is mapped, before YouTube — so synthesis can start early. */
  onGoogle?: (hits: Map<string, ExternalHit[]>) => void;
};

/**
 * Background shortlist scrape: Google (Reddit + YouTube SERP + articles) per option as soon as the
 * shortlist is known. Optional YouTube actor runs after; `onGoogle` lets the agent synthesize early.
 */
export async function prefetchProductHits(
  products: { id: string; title: string; brand?: string }[],
  opts: PrefetchProductOpts = {},
): Promise<Map<string, ExternalHit[]>> {
  const out = new Map<string, ExternalHit[]>();
  const token = opts.token ?? apifyToken();
  if (!token || !products.length) {
    opts.onGoogle?.(out);
    return out;
  }
  const phrases = products.map((p) => productPhrase(p.title, p.brand));
  const modelKeyFor = products.map((p) => {
    const keys = modelKeys(p.title, p.brand);
    return keys.length ? preferredModelKey(keys) : undefined;
  });
  const queryToProduct = new Map<string, number>();
  const queries: string[] = [];
  for (let i = 0; i < phrases.length; i++) {
    for (const q of productExternalQueries(phrases[i]!, modelKeyFor[i])) {
      queries.push(q);
      queryToProduct.set(q.toLowerCase(), i);
    }
  }
  const budgetMs = opts.budgetMs ?? productBudgetMs();
  console.log(`[apify] Google external for shortlist (${queries.length} queries, budget ${budgetMs} ms)`);
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
    opts.hedge !== false,
  );
  for (const raw of items) {
    const term = String((raw as { searchQuery?: { term?: unknown } } | null)?.searchQuery?.term ?? "").toLowerCase();
    const i = queryToProduct.get(term);
    if (i == null) continue;
    const p = products[i]!;
    const prev = out.get(p.id) ?? [];
    out.set(
      p.id,
      mergeHits(
        prev,
        hitsFromSearchItems([raw]).filter((h) => hitMatchesProduct(`${h.title ?? ""} ${h.body}`, p.title, p.brand)),
      ),
    );
  }
  console.log(`[apify] Google shortlist hits: ${products.map((p, i) => `${phrases[i]} ${out.get(p.id)?.length ?? 0}`).join(", ")}`);
  opts.onGoogle?.(new Map(out));

  if (opts.youtube === false) return out;

  // Sequential YouTube actor after Google so we stay under the concurrent-run cap.
  console.log(`[apify] YouTube actor for ${phrases.length} shortlist phrases`);
  const ytItems = await runActor(
    YOUTUBE_ACTOR,
    {
      searchQueries: phrases.map((p, i) => `${searchHead(p, modelKeyFor[i])} review`),
      maxResults: 3,
      maxResultsShorts: 0,
      maxResultStreams: 0,
    },
    token,
    Math.min(budgetMs, 60_000),
    opts.fetchImpl ?? fetch,
    opts.signal,
  );
  const ytHits = hitsFromYoutube(ytItems);
  for (let i = 0; i < products.length; i++) {
    const p = products[i]!;
    const matched = ytHits.filter((h) => hitMatchesProduct(`${h.title ?? ""} ${h.body}`, p.title, p.brand));
    if (!matched.length) continue;
    out.set(p.id, mergeHits(out.get(p.id) ?? [], matched));
  }

  console.log(`[apify] per-product external hits: ${products.map((p, i) => `${phrases[i]} ${out.get(p.id)?.length ?? 0}`).join(", ")}`);
  return out;
}

/**
 * Deepen Google-discovered Reddit URLs with a bounded thread scrape (post + top comments).
 * Does not search Reddit from scratch — only opens URLs we already have. Soft-capped so Q&A can stay on snippets.
 */
export async function enrichWithReddit(
  products: { id: string; title: string; brand?: string }[],
  existing: Map<string, ExternalHit[]>,
  opts: { token?: string; budgetMs?: number; fetchImpl?: ApifyFetch; signal?: AbortSignal } = {},
): Promise<Map<string, ExternalHit[]>> {
  const out = new Map(existing);
  const token = opts.token ?? apifyToken();
  if (!token || !products.length) return out;

  const urlToProduct = new Map<string, string>();
  const startUrls: { url: string }[] = [];
  for (const p of products) {
    for (const url of pickRedditUrls(out.get(p.id) ?? [], REDDIT_URLS_PER_PRODUCT)) {
      const key = redditPostKey(url);
      if (!key || urlToProduct.has(key)) continue;
      urlToProduct.set(key, p.id);
      startUrls.push({ url });
      if (startUrls.length >= REDDIT_URLS_TOTAL) break;
    }
    if (startUrls.length >= REDDIT_URLS_TOTAL) break;
  }
  if (!startUrls.length) {
    console.log("[apify] Reddit enrich skipped (no Google Reddit URLs)");
    return out;
  }

  const budgetMs = opts.budgetMs ?? redditBudgetMs();
  console.log(`[apify] Reddit thread enrich for ${startUrls.length} URLs (budget ${budgetMs} ms)`);
  const items = await runActor(
    REDDIT_ACTOR,
    {
      startUrls,
      skipComments: false,
      maxComments: REDDIT_MAX_COMMENTS,
      maxPostCount: startUrls.length,
      maxItems: startUrls.length * (REDDIT_MAX_COMMENTS + 2),
      proxy: { useApifyProxy: true },
    },
    token,
    budgetMs,
    opts.fetchImpl ?? fetch,
    opts.signal,
  );
  const deep = hitsFromReddit(items, urlToProduct);
  for (const h of deep) {
    const key = h.url ? redditPostKey(h.url) : null;
    const productId = key ? urlToProduct.get(key) : undefined;
    if (!productId) continue;
    const p = products.find((x) => x.id === productId);
    if (p && !hitMatchesProduct(`${h.title ?? ""} ${h.body}`, p.title, p.brand)) continue;
    // Prefer the deepened thread body over the SERP snippet for the same URL.
    const prev = [...(out.get(productId) ?? [])].filter((x) => !(x.source === "reddit" && x.url && h.url && redditPostKey(x.url) === key));
    out.set(productId, mergeHits(prev, [h]));
  }
  console.log(
    `[apify] Reddit enrich: ${deep.length} threads → ${products.map((p) => `${productPhrase(p.title, p.brand)} reddit=${(out.get(p.id) ?? []).filter((h) => h.source === "reddit").length}`).join(", ")}`,
  );
  return out;
}

/** YouTube actor only — merge into hits already gathered from Google (no second SERP run). */
export async function enrichWithYoutube(
  products: { id: string; title: string; brand?: string }[],
  existing: Map<string, ExternalHit[]>,
  opts: { token?: string; budgetMs?: number; fetchImpl?: ApifyFetch; signal?: AbortSignal } = {},
): Promise<Map<string, ExternalHit[]>> {
  const out = new Map(existing);
  const token = opts.token ?? apifyToken();
  if (!token || !products.length) return out;
  const phrases = products.map((p) => productPhrase(p.title, p.brand));
  const modelKeyFor = products.map((p) => {
    const keys = modelKeys(p.title, p.brand);
    return keys.length ? preferredModelKey(keys) : undefined;
  });
  const budgetMs = Math.min(opts.budgetMs ?? productBudgetMs(), 60_000);
  console.log(`[apify] YouTube enrich for ${phrases.length} shortlist phrases`);
  const ytItems = await runActor(
    YOUTUBE_ACTOR,
    {
      searchQueries: phrases.map((p, i) => `${searchHead(p, modelKeyFor[i])} review`),
      maxResults: 3,
      maxResultsShorts: 0,
      maxResultStreams: 0,
    },
    token,
    budgetMs,
    opts.fetchImpl ?? fetch,
    opts.signal,
  );
  const ytHits = hitsFromYoutube(ytItems);
  for (let i = 0; i < products.length; i++) {
    const p = products[i]!;
    const matched = ytHits.filter((h) => hitMatchesProduct(`${h.title ?? ""} ${h.body}`, p.title, p.brand));
    if (!matched.length) continue;
    out.set(p.id, mergeHits([...(out.get(p.id) ?? [])], matched));
  }
  return out;
}

export async function collectViaApify(
  product: ProductDetail,
  opts: { token?: string; budgetMs?: number; fetchImpl?: ApifyFetch; signal?: AbortSignal } = {},
): Promise<RawReview[]> {
  const hits = (await prefetchProductHits([product], opts)).get(product.id) ?? [];
  return hitsToReviews(product.id, hits, "apify-own");
}
