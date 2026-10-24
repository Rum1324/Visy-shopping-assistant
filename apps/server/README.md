# Navigator MVP (Track C): Moss-first, Claude-fallback

Element picking for the browser agent, fastest first:

```
0. shortcut URL + deterministic extraction (amazon.com/s?k=…)          no AI
1. memory  Moss session of past successful picks, saved to data/        ~5 ms
2. moss    shared local Moss session over element texts (α=0.2)         new text ~1.5 ms/element, ~4 ms per query
3. claude  Haiku 5.5 / low / thinking off picks from the element list   ~1.2 s, result written back to memory
```

Purchase buttons (`purchaseRisk`) are never candidates. Bot checks return `err("blocked")`; the human solves them in the window.

## Results (2026-10-24)

**Moss spike:** query p50 2.7 ms. The first session loads the model (2–7 s), so warm it at boot. `addDocs` costs about 1.5 ms per element. The Moss index is a single session shared across pages, and only new element text gets embedded. Pages with mostly new text cost about 0.8 s at p50; repeat pages cost about 0.

**Bench** (38 cases on 10 real pages: Amazon search and product, Target search, Walmart search):

| Picker | Correct | Wrong clicks | p50 | p95 |
|---|---|---|---|---|
| Moss α=0.2, gap ≥ 0.1 (trusted only) | 24/24 trusted (63% of steps) | 0 | 3.5 ms | 5 ms |
| Moss α=0.8 (Moss default) | 33/38 | 5 (and confident) | 5 ms | 10 ms |
| **Haiku 5.5, low effort, thinking off** ← default | 38/38 | 0 | 1.17 s | 1.9 s |
| Haiku 5.5, low effort, thinking on | 38/38 | 0 | 1.24 s | 2.1 s |
| Sonnet 5.5, low effort, thinking off | 38/38 | 0 | 1.25 s | 2.2 s |
| Sonnet 5.5, low effort, thinking on | 37/38 (1 abstain) | 0 | 1.17 s | 2.7 s |
| Opus 5.5, low effort | 35/38 (3 abstain) | 0 | 1.99 s | 2.9 s |

Claude sees elements as `e<idx>`, not bare numbers. With bare numbers, every model answered "107" for the review link named "(107,591)".

**Live Amazon demo** ("picnic blanket": search, open, Add to Cart, cart; signed-in profile; browser and model already warm):

| Run | Add to Cart picked by | Claude calls | Total, v1 | Total, now |
|---|---|---|---|---|
| Warm (memory hit) | memory, 5–9 ms | 0 | 11.3 s | **3.4–4.0 s** |
| Cold (empty memory) | Moss, 4 ms (+ about 1.5 s embedding during load) | 0 | 13.1 s | **6.1 s** |
| Claude only (`PICKER_CHAIN=claude`) | Claude, 1.5 s | 1 | 11.5 s | 6.8 s |

What made it fast (`PROFILE=1 npm run demo` prints the breakdown):
- Navigate with `waitUntil: "commit"`, then poll for what the step needs: result cards, the control, the confirmation, the subtotal. No fixed sleeps, and no waiting for DOMContentLoaded after clicks; that wait alone cost 1.7 s.
- Pick while the page is still streaming. Memory, and Moss in strict mode (trusted only on an exact role+name match), run on every ~150 ms snapshot, so Moss embeds new element text while the network is still busy. The full chain, with Claude, runs only once the DOM is ready: at most one Claude call per step.
- Moss embeds only the 30 most plausible elements per step (role + keyword prefilter, `MOSS_PREFILTER`, C1a), out of the first 150 (viewport first). Bench: the correct element survived the filter 38/38, 0 wrong clicks, embedding 445 → 144 ms per page. `npm run bench -- --no-claude` re-runs it without API calls (Claude rows come from `bench/claude-cache.json`).

The rest is Amazon: about 0.9 s for the search results to arrive, about 0.5 s for each page's first byte.

**Preload (C1b).** `flow.preload(asins)` opens the 3 shortlisted product pages in background tabs and runs Moss over them while the shortlist is read aloud. `open(asin)` then just switches tabs. Call it, without awaiting, when the shortlist is final. Measured with `npm run demo -- "<query>" [--preload]` on products the profile had never opened (signed-out profile, memory warm):

| Run | open + Add to Cart |
|---|---|
| No preload (2 runs) | 1.95–2.4 s |
| **Preload** (3 runs) | **0.81–0.92 s** |

Preloading 3 pages took 5.0–6.0 s, which is less than the narration, so `open` never waited. Most of what's left is Playwright's click (~0.7 s).

**Retailer reviews (C2).** `flow.getDetail(candidate)` opens the product page and, at the same time, scrapes reviews in a background tab (`flow.reviews(asin, 30)`). It returns `ProductDetail.retailerReviews` as `RawReview { source: "retailer", untrusted: true }` with rating, title, body, date, author and verified purchase. Run it with `npm run reviews -w @visy/server -- "<query>" | <ASIN>`.

- **Sign-in required.** Amazon redirects `/product-reviews/` and `/portal/customer-reviews/` to `/ap/signin` when signed out. Signed out, `reviews()` falls back to the product page's top reviews (13 for the picnic blanket) and reports `gated: true`. Sign in once with `npm run reviews -- --login "<query>"`.
- **Paging:** "Show 10 more reviews" appends in place; `pageNumber=N` URLs are ignored. Its click handler is bound late, so the scraper waits for `readyState === 'complete'` and retries the click once.

Measured 2026-10-24, signed-in profile, browser warm:

| Product | Reviews | `reviews()` alone | `getDetail` (product page + reviews in parallel) |
|---|---|---|---|
| Picnic blanket B0FC2HQHQ4 | 30, all with rating+title+body+date (3 pages) | 2.7–3.1 s | 1.6 s |
| USB-C cable B0CZDJTRPZ | 30, all complete (3 pages) | 1.6 s | 1.8 s |
| Picnic blanket, signed out | 13 from the product page | 3.9 s | 3.0 s |

First page ~0.3–0.5 s, then ~0.5 s per "show more". Review text is untrusted data for D; nothing here acts on it.

**Product details (C3): `RecipeCache`.** `getDetail` now fills price, list price, deal, Prime, rating, review count, brand, stock, delivery, bullets, description, banners, specs, variants and image URLs. On the first visit to a page type (`amazon:product`), Claude (`CLAUDE_RECIPE_MODEL`, default Haiku 5.5) gets a pruned HTML outline of the page (~75–80k chars) and writes CSS selectors for each field. That recipe is saved to `data/recipes.json`. Later visits replay it in the page with no AI. A recipe "hits" when it finds the price and at least 60% of the fields it found when it was written. A miss (new layout, a different template like books) costs one Claude call for a new recipe, kept next to the old ones (up to 5 per page type). If Claude can't write one (no key, API error or usage limit), a hand-checked seed recipe (`AMAZON_PRODUCT_SEED`) takes its place. Selectors only go to `querySelector`; a recipe can read a page, never click.

`npm run detail -- "<query>"` visits A, A again, then B, and prints `via` and the Claude call count for each. Measured 2026-10-24, fresh signed-out profile, empty `data/`:

| Run | Visit 1 (writes the recipe) | Visit 2, same product | Visit 3, another product |
|---|---|---|---|
| "picnic blanket", Haiku 5.5 | 1 Claude call, 5.4 s | **0 calls**, 47 ms | **0 calls**, 80 ms |
| "usb c cable", Sonnet 5.5 | 1 Claude call, 13 s | **0 calls**, 25 ms | **0 calls**, 137 ms |

Fields read on replay: price, rating, review count, Prime, delivery, stock, 27–35 specs, 5–7 images, color variants (5 and 22 options), list price and "Limited time deal" when shown, "Only 8 left in stock" as a banner. `RECIPE_FROM=recipe.json` stands in for the Claude call; `OUTLINE_OUT=file.html` saves what Claude sees.

## Setup

1. Copy the root `.env.example` to `apps/server/.env`, then fill in `ANTHROPIC_API_KEY`, `MOSS_PROJECT_ID` and `MOSS_PROJECT_KEY`. Get the Moss values from the moss.dev portal; redeem `CALHACKS` on its billing page.
2. Run `npm install` at the repo root.
3. Optional but recommended: run `npm run snap -w @visy/server -- amazon` once and sign in to Amazon in the window that opens. The profile in `.visy-profile/` keeps you signed in and gets fewer bot checks.

## Test, in this order

| Command (`-w @visy/server`) | Needs | What it tells you |
|---|---|---|
| `npm test` | nothing | Chain and safety logic: purchase buttons are never picked, untrusted picks fall through |
| `npm run spike` | Moss keys | Moss `addDocs` time for 50/150/300 elements and query p50/p95. If addDocs for 300 is over ~300 ms, drop the `moss` tier |
| `npm run snap -- amazon walmart target` | a terminal (bot checks) | Saves real `PageState`s to `bench/snapshots/` |
| `npm run bench [-- --no-claude]` | Moss (+ Anthropic) keys | Per-picker accuracy and latency, a `MOSS_GAP` sweep with zero wrong clicks, and chain vs Claude-only |
| `npm run demo -- "picnic blanket"` | keys + headed Chrome | Live run: search, top 3, open #1, Add to Cart, cart subtotal. Stops before checkout |
| `npm run reviews -- "picnic blanket"` | headed Chrome, signed-in profile | C2: getDetail review count, a sample, timings. No cart actions |
| `npm run detail -- "picnic blanket"` | headed Chrome (+ Anthropic key for the first visit) | C3: detail fields and Claude calls per visit; the second visit should say `0 Claude call(s)` |

Speed claim for the demo:

```bash
PICKER_CHAIN=claude npm run demo -w @visy/server -- "picnic blanket"   # baseline
rm -rf apps/server/data && npm run demo -w @visy/server -- "picnic blanket"   # cold: moss + claude
npm run demo -w @visy/server -- "picnic blanket"   # warm: memory hits, Claude calls → 0
```

Every pick is appended to `logs/picks.jsonl`, which is the bake-off data.

## Extension integration (for Track A)

`src/navigator/driver/extension.ts` (`ExtensionDriver`) runs the six `DriverRequest` ops over the WebSocket. It needs no contract change:

```ts
const driver = new ExtensionDriver((msg) => socket.send(JSON.stringify(msg)));
// for each parsed ClientMsg:   if (msg.type === "driver.response") driver.handle(msg);
// on socket close:             driver.dispose();
```

It validates every payload with `DriverResponseData[op]`, times out after `BUDGETS_MS`, refuses `purchaseRisk` clicks, and turns bot checks into `err("blocked")`. It is covered by `test/extension-driver.test.ts`.

**Wired in `ws.ts` (C5).** Each connection gets an `ExtensionDriver`; `driver.response` goes to `driver.handle`, and socket close disposes it. `capturePage()` (`src/navigator/capture.ts`) snapshots the tab the user is looking at (`tabId: ACTIVE_TAB`, resolved by `background.js`) and returns a `PageState`. The agent gets it as `sink.capturePage`; Track D builds "what's on this page?" on top. Its `textBlocks` and element names are untrusted page text. Covered by `test/capture.test.ts`, which runs the real `content.js` + `indexer.js` in Chromium when one is available.

The content script now runs `INDEXER_JS` via `apps/extension/indexer.js`, generated by `npm run gen-indexer -w @visy/server` (the test fails if it drifts). The manifest has `<all_urls>` host access so capture works on any site.

Open items, to agree with Track A before changing contracts:
- **Speed tricks:** `AmazonFlow` also uses three Playwright-only helpers: `evaluate` (result cards, subtotal), `waitFor` (poll a condition) and `isBlocked`. The extension equivalent would be additive ops, for example `{ op: "extract", recipe: "amazon.results" | "amazon.subtotal" }` and `{ op: "waitFor", condition: … }`. MV3 can't `eval` strings, so these must be named recipes built into the content script, not arbitrary JS.
