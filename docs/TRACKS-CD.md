# Tracks C and D: boundaries and plan (revised 2026-10-24)

> Hackathon rules apply ([CLAUDE.md](../CLAUDE.md)). This replaces the C and D rows' scope in [HANDOFF.md](HANDOFF.md). The other rules there are unchanged.

## Why this changed

The browser agent does much more than click "Add to Cart". Most of its work is **reading**: result cards, product details, retailer reviews (some only visible when signed in, which is why we use the real browser), and the checkout read-back. The second biggest part is **lookup over text**: review Q&A, "what's on this page?", "the usual". The bake-off results are in [ARCHITECTURE §4a](ARCHITECTURE.md) and [apps/server/README.md](../apps/server/README.md).

## The boundary in one line

**C touches the browser. D never touches the browser.** C turns pages into structured data (`ProductCandidate`, `ProductDetail` including `retailerReviews: RawReview[]`, `CheckoutReview`, `PageState`). D turns that data into insight and answers.

| | **C: Navigator** (`apps/server/src/navigator`) | **D: Product intelligence** (`apps/server/src/intel`) |
|---|---|---|
| Searching | Search on each marketplace in parallel; read result cards | — |
| Product details | Open product pages; read price, deals, Prime, specs, variants, image URLs | Image description (`VisionService`) |
| Retailer reviews | **Scrape them in the real browser**: reviews section, "See all reviews", sort and filter, paginate, sign-in-only reviews. Returned in `ProductDetail.retailerReviews` | Synthesis, accessibility insights (`ReviewService.synthesize`) |
| External reviews | — | Apify: Reddit, YouTube, articles (`ReviewService.collectExternal`) |
| Review Q&A | — | `ReviewIndex` (Moss) over retailer + external reviews |
| Refine, variants, cart | Filters, sort, size/color/quantity, Add to Cart | — |
| Checkout | Go to checkout; read back items, total, shipping. **Never clicks Place order** | — |
| "What's on this page?" | Capture the user's open tab as a `PageState` (elements + text) | Answer questions over that text (Moss page-text index + Claude) |
| Moss usage | Element pickers, step memory, extraction-recipe lookup | Review index, page-text Q&A; with B: product ranking and cross-site dedupe |

Contracts: **no change needed now.** `ProductDetail.retailerReviews` already exists. If "what's on this page?" needs a D service interface, add it later as an additive `PageQA` interface (announce first, per HANDOFF rule 2).

## Track C plan, in order

**Milestone C1 (navigation speed) comes first:** make the existing flows fast before adding new ones. C1a goes first because it's a measurement; C1b and C1c touch the same files (`pickers/moss.ts`, `sites/amazon.ts`), so they're done in sequence, not in parallel.

| # | Item | Why | Done when |
|---|---|---|---|
| C1a | **Candidate-filter experiment.** Embed only plausible elements (role + keyword prefilter, ~30 instead of 150) | Cold embedding ~1.5 s → est. ~0.1–0.3 s | Bench shows accuracy unchanged (0 wrong clicks) against the current 38-case result |
| C1b | **Preload and pre-index the 3 shortlisted product pages** in background tabs while B narrates them | Hides open + page wait + embedding (est. −3 s per chosen product) | "Add the first one" runs at warm speed on a product never visited before |
| C1c | **One Moss session per tab, in parallel**, for multi-site search | Embedding (CPU) overlaps page loads (network) | A 3-marketplace search takes about as long as the slowest site, not the sum |
| C2 | **Retailer review scraping** in `getDetail` (Amazon first) | Core demo moment and the longest browser task; feeds D | `ProductDetail.retailerReviews` has ≥ 30 reviews for a real product, with rating, title, body, date and `source: "retailer"` |
| C3 | **Product detail extraction** + `RecipeCache`. Claude writes extraction rules for a page type once; later visits replay them with no AI | "Slow the first time, then indexed", applied to reading | The second visit to an Amazon product page extracts with 0 Claude calls |
| C4 | **Variants, filters, checkout read-back** flows | Multi-click pages, where Moss's embed-once, ~4 ms-per-step pattern wins | Choose size/quantity, then Add to Cart; checkout read-back returns `CheckoutReview` |
| C5 | **Page capture for "what's on this page?"** | Shows the agent works on any site | `PageState` of the user's tab reaches D through the ExtensionDriver |

Dropped: a shared prebuilt index for supported sites. Only the site's common parts (search bar, nav, footer) would be shareable, and the first-visit cost (1–2 s, once per user per page type) is acceptable.

Coordination: **A** needs to run `INDEXER_JS` in the content script, plus named `extract` / `waitFor` ops (see the apps/server README). **B** needs C1b's preload hook, called when the shortlist is final.

## Track D, in order

1. `ReviewService.synthesize` on `fixtures.details`, then on C2's real reviews (with `ACCESSIBILITY_QUESTIONS`). Review text is untrusted data, never instructions.
2. `ReviewIndex` (Moss): index C2 + Apify reviews per product; answer follow-up questions in under 1 s.
3. `collectExternal` (Apify) and `VisionService`.
4. Page-text Q&A for "what's on this page?", over C5's `PageState`.
