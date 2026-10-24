# Team split & data handoff rules

Goal: **nobody waits on anybody.** Every track builds against `packages/contracts` (types, fixtures, mocks, mock server) from minute one and swaps in real neighbors as they land.

## Tracks

| Track | Owns | Implements (contracts) | Builds against (until real) |
|---|---|---|---|
| **A: Extension & Voice** | `apps/extension` (side panel UI, mic, audio playback, hotkey, content-script indexer and executor, tab group), plus the server's voice gateway (Cartesia STT/TTS, barge-in, speech rate) | `ClientMsg`/`ServerMsg` client side, `DriverRequest` handling, `PageState` producer, `VoiceOut` | `npm run mock-server` |
| **B: Conversation agent** | `apps/server` core: WebSocket server, session state machine, Claude tool loop, clarifying questions, shortlist ranking and narration, refine loop, checkout gate, `PreferenceStore` (Moss) | `ServerMsg` producer, `SessionState` owner, `PreferenceStore` | `mockServices()`, plus `user.text` messages from a WebSocket client such as `wscat` |
| **C: Navigator (Jev + Moss)** | `apps/server/src/navigator`: `ExtensionDriver`, `PlaywrightDriver`, `JevPicker`, `MossPicker`, `ClaudePicker`, `RecipeCache`, per-marketplace search, detail and cart flows, **picker bake-off** | `Navigator`, `BrowserDriver`, `ElementPicker`, `JevClient` | `fixtureDriver()`, then `PlaywrightDriver` on real sites. Never needs the extension. |
| **D: Product intelligence** | `apps/server/src/intel`: review synthesis (with `ACCESSIBILITY_QUESTIONS`), Apify external reviews (Reddit, YouTube, articles), image description, `ReviewIndex` (Moss) | `ReviewService`, `VisionService`, `ReviewIndex` | `fixtures.details`, `fixtures.externalReviews` |

**With 3 people:** A = 1 person, C = 1 person, B + D = 1 person. D is mostly prompts plus one Apify call, so it pairs well with B.

## Handoff rules

1. **`packages/contracts` is the only shared surface.** No track imports another track's files. Server modules talk only through the interfaces in `services.ts`, injected as `Services`.
2. **Contract changes are additive only.** Add optional fields freely in a small PR and announce it in chat. Never rename, remove or tighten a field. If you truly must, bump `CONTRACT_VERSION` and get a 👍 from every track owner first.
3. **Fixtures change with the schema.** If you add a field, add it to `src/fixtures.ts`. `npm test` must pass on `main` at all times.
4. **Validate at every boundary.** Parse incoming WebSocket messages with `ClientMsg`/`ServerMsg`, and driver payloads with `DriverResponseData[op]`. Log invalid data and keep going; don't crash.
5. **No throwing across a module boundary.** Return `Result<T>` (`ok()` / `err(code, msg, retryable)`). **Partial results are success:** two of three marketplaces is a good answer.
6. **Respect time budgets.** Use `BUDGETS_MS`. On timeout, return `err("timeout", …, true)` with whatever you have. The agent decides whether to retry or move on.
7. **Slow work talks.** Anything over ~1 s calls `emit(ProgressEvent)` with a short, speakable message. Only Track A decides what actually gets spoken.
8. **One owner per piece of state.** `SessionState` is mutated only by Track B. Everyone else gets snapshots.
9. **IDs, money and time:** product IDs are `${marketplace}:${nativeId}`, money is integer cents, timestamps are ISO-8601 UTC.
10. **Untrusted text stays data.** `RawReview.body`, `PageState.textBlocks` and product copy never go into a system prompt as instructions. Wrap them in clearly delimited quote blocks. The prompt-injection review in the fixtures is a test case.
11. **Nobody places orders.** No `Action` can submit an order, elements marked `purchaseRisk` are never clicked, and the user presses the final button.
12. **Secrets stay on the server.** Copy `.env.example` to `apps/server/.env`. The extension contains no keys.
13. **Git:** one branch per track (`a/…`, `b/…`, `c/…`, `d/…`), small PRs, merge to `main` at least every 2 hours. `main` always builds and passes `npm test`.

## Integration checkpoints

| When | Done means |
|---|---|
| **H+1** | Everyone has run `npm test` and `npm run mock-server`. Contract v1 is frozen (additive changes only from here). |
| **H+1.75** | Track C picker bake-off result is posted: picker chain chosen, GAP and THRESHOLD set (see ARCHITECTURE §4a). |
| **H+5** | Each track works end-to-end against mocks: A talks to the mock server, B runs the full flow on `mockServices()`, C returns real Amazon candidates through Playwright, D synthesizes real reviews. |
| **H+8** | First real integration: B runs with C and D implementations, and A connects to the real server. |
| **H+12** | `ExtensionDriver` replaces Playwright for logged-in data, plus checkout read-back. |
| **H+14** | Feature freeze. Rehearse the demo script ("picnic blanket": Amazon, Target and Walmart in under 15 s, then accessibility review insights, then "the usual seaweed"). Warm the RecipeCache before going on stage. |

## Open questions (owner: whoever picks it up first)

- Jev: endpoint, auth, request and response shape, rate limits (Track C).
- Moss: per-page indexing latency, and whether the client can run in Node (Tracks C and D).
- Cartesia: can the browser connect directly with a short-lived token, or must audio go through our server? (Track A)
- Are we also targeting motor-impaired users? If so, voice-only must be complete, with no required clicks (Tracks A and B).
