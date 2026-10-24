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
- Moss indexes only the first 150 elements (viewport first). Every bench target sits at idx ≤ 101.

The rest is Amazon: about 0.9 s for the search results to arrive, about 0.5 s for each page's first byte.

**Preload (C1b).** `flow.preload(asins)` opens the 3 shortlisted product pages in background tabs and runs Moss over them while the shortlist is read aloud. `open(asin)` then just switches tabs. Call it, without awaiting, when the shortlist is final. Measured with `npm run demo -- "<query>" [--preload]` on products the profile had never opened (signed-out profile, memory warm):

| Run | open + Add to Cart |
|---|---|
| No preload (2 runs) | 1.95–2.4 s |
| **Preload** (3 runs) | **0.81–0.92 s** |

Preloading 3 pages took 5.0–6.0 s, which is less than the narration, so `open` never waited. Most of what's left is Playwright's click (~0.7 s).

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

Open items, to agree with Track A before changing contracts:
- **Indexing:** the content script should run `INDEXER_JS` from `src/navigator/driver/indexer.ts`, which is plain JS with no imports. Then extension `PageState`s match what the pickers were tuned on, including `section` names, viewport-first order and `purchaseRisk`.
- **Speed tricks:** `AmazonFlow` also uses three Playwright-only helpers: `evaluate` (result cards, subtotal), `waitFor` (poll a condition) and `isBlocked`. The extension equivalent would be additive ops, for example `{ op: "extract", recipe: "amazon.results" | "amazon.subtotal" }` and `{ op: "waitFor", condition: … }`. MV3 can't `eval` strings, so these must be named recipes built into the content script, not arbitrary JS.
