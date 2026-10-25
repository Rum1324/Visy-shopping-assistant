# Improvisations

Living log of changes that depart from the skeleton in `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, and `packages/contracts`. Newest entries go first.

If you improvise, add an entry in the same commit and push it. Say what changed, why the skeleton was not enough, and what other agents should do differently now.

## 2026-10-24 — Questions first, then a ~30-product pool narrowed to 3 (B-NARROW)

A new product request now gets 2–3 spoken questions first (budget, what matters, who it's for). The answer fills `Need.budget`, `mustHaves`, `niceToHaves` and `accessibilityNotes`, and only then do we search. `VISY_CLARIFY=0` turns the questions off. The Claude tool loop asks with `ask_shopping_questions`. If it calls `search` without asking first, the agent asks default questions instead.

Search keeps the whole page as candidates (up to `VISY_POOL_PER_MARKET`, default 30). Amazon page 1 gives about 20 organic products after sponsored ones are dropped. `narrow.ts` picks 3 using the contracts' `JevClient.decide` shape: "best match", "best value" and "most trusted by buyers" run in parallel, and repeats are asked again without the products already picked. Real Jev isn't wired up, so `haikuJev()` stands in (Haiku 5.5, thinking off, about 1.4 s per call, about 2–3 s total). The rating heuristic fills in when there's no key or a call fails. To switch to real Jev, pass a real `JevClient` as `createAgent(..., { jev })`.

Amazon result cards now also report the review count, so `npm run gen-indexer` regenerated `apps/extension/scripts.js`. Reload the extension.

## 2026-10-24 — Listen after the greeting

When the Cartesia welcome clip ends, the side panel opens the mic (`audio.start` / PCM / `audio.end`) and Cartesia STT turns the utterance into `handleText`. It listens again after Visy finishes speaking.

Chrome will not show a mic prompt inside the side panel. The extension opens `mic.html` as a tab; the user clicks Allow microphone there, then the side panel can use the same origin permission.

## 2026-10-24 — Real Chrome via the extension (a/real-chrome)

Merged `origin/a/real-chrome` into local `main`. When `NAV=amazon`, Amazon search/cart runs in the connected Visy extension's Chrome (`extract` / `waitFor` named page scripts in `apps/extension/scripts.js`). Playwright is only the fallback if no extension is connected or `DRIVER=playwright`.

Target and Walmart still use fixtures until those site flows exist. Bot checks are handed to the user in their own tab; we do not bypass them.

## 2026-10-24 — All spoken audio is Cartesia

The side panel no longer uses `chrome.tts` or `speechSynthesis`. Every `agent.say` (including the open greeting and progress lines) is synthesized on the server with Cartesia PCM.

`hello` gained an optional additive `displayName`. The server greets with `Hi {name}, What can I do for you today?` so the welcome voice matches the on-screen spark-in. Clients that omit `displayName` still work; they get the nameless greeting.

The extension should send `displayName` on hello, play `tts.*` even before chat starts (onto `#welcome-line`), and never fall back to a local voice.

## 2026-10-24 — Working agreement, no product deviation

The project is high-paced. Agents may leave the skeleton when it blocks the work, as long as the departure is written here and pushed.

Cloud Agent setup follows the skeleton as it exists today: `npm ci`, `npm test`, `npm run typecheck`, and `npm run mock-server` on port 8787. `apps/extension` and `apps/server` are not in the repo yet. Secrets in `.env.example` stay unused until that server exists.
