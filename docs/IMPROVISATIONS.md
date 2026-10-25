# Improvisations

Living log of changes that depart from the skeleton in `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, and `packages/contracts`. Newest entries go first.

If you improvise, add an entry in the same commit and push it. Say what changed, why the skeleton was not enough, and what other agents should do differently now.

## 2026-10-24 — Drop loaded-language reviews before synthesis (D-UNBIASED)

`ReviewService.synthesize` now runs `excludeLoaded` over the retailer + Apify pool before Claude sees it. Reviews with stacked hype/rage markers (e.g. "life changing", "don't waste your money", heavy ALL CAPS, `!!!`) are set aside when enough calmer reviews remain; if the calm pool is thin we keep the least-loaded ones so synthesis still has evidence. A speakable warning notes how many were set aside. Heuristic only — no new contract fields. Other agents: don't re-prompt Claude to "ignore bias"; filter first in `intel/reviews.ts`.
## 2026-10-24 — Side panel settings: Cartesia voice speed (UX-SPEED)

The wire already had `settings.update.speechRate` and the server already passed it to Cartesia. The extension had no UI. Gear (top right) opens a Settings page with a Voice speed slider (0.6–3×). Cartesia Sonic only accepts `generation_config.speed` 0.6–1.5. Above 1.5× the side panel **WSOLA time-compresses** the PCM (keeps pitch; no chipmunk `playbackRate`). Example: 3× = Cartesia 1.5 × WSOLA 2. `speechRate` max in contracts is 3. Value is kept in `localStorage` (`visy.speechRate`) and sent on every connect after `hello`, and again when the slider changes. Reload the extension after pulling.

## 2026-10-24 — Progress lines name Apify

When `APIFY_TOKEN` is set, progress messages say "Using Apify…" / "Got Apify results from …" so the demo calls out the API. Without a token, wording stays generic. Prefetch starts as soon as the shopper query is known, in parallel with marketplace search.

## 2026-10-24 — Progress TTS is calm + declarative

`agent.say` with `kind: "progress"` is spoken only when TTS is idle (`ws.ts` skips progress audio while another say is queued). Cartesia was reading trailing `…` with rising question intonation. `speechForKind` in `voice.ts` strips trailing ellipses, ends with a period, and sets `generation_config.emotion` to `calm` for progress (`curious` for questions).

## 2026-10-24 — Apify external reviews via parallel actors (D-APIFY)

Outside reviews: `prefetchApifySearch` runs **three Apify actors in parallel** (Reddit lite search, YouTube search, one Google SERP for articles only) under `APIFY_BUDGET_MS` (default 25 s), started as soon as the shopper query is known. We deliberately do **not** chain full transcript/page scrapes after discovery — that is the slow path; search snippets (+ YouTube description/captions when the actor returns them) feed Claude. The shortlist still uses main's narrow + `present.ts` overview/pitch; Apify hits are shared across the three options via `reviewsFromHits`.

## 2026-10-24 — Team feedback: one question per turn, option tabs, shorter options, real checkout total

- **Questions one at a time (UX-ASK-FIRST).** The questions from `ask_shopping_questions` are asked one per turn, and the agent asks the next one itself with no model call. "Just search" or "skip" ends them early. The last answer goes to Claude with every question and answer in `session_state`.
- **Option tabs (A-SHOWPAGE, B-PRELOAD).** After narrowing, the agent says "Opening the 3 tabs now", and `Navigator.openOptions` (new, optional, additive) opens each Amazon option in its own tab with option 1 in front. Each product keeps its tab (`AmazonFlow.productTabs`), so getDetail runs for all three at once and Add to Cart always uses the chosen option's tab. A new search closes the old option tabs. Search uses its own tab.
- **How options are read (UX-FORMAT, UX-LEN).** First a one-line overview ("Best match: X, $45.99. Best value: …"), then one comparative sentence per option ("If you want to spend less, …, $6 cheaper"), written by Haiku in `present.ts`, with a template fallback. It ends with "Want to hear more about one, or should I add one to your cart?" The photo description and accessibility answers moved to follow-up questions.
- **Checkout read-back (B-READBACK).** From the cart, the flow presses Proceed to checkout (not a purchase button) and reads the order total with tax on the review page: "Your Amazon total is $107.23, including $7.25 tax. Press Place your order when you're ready." If that page doesn't come up (sign-in, Prime upsell), it reads the cart subtotal before tax and says "Press Proceed to checkout". It never says "I will not place the order" any more. Visy still never presses that button.
- **Sample listings** for Target and Walmart (always picnic blankets) are only offered when they match the search words.

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
