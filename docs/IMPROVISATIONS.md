# Improvisations

Living log of changes that depart from the skeleton in `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, and `packages/contracts`. Newest entries go first.

If you improvise, add an entry in the same commit and push it. Say what changed, why the skeleton was not enough, and what other agents should do differently now.

## 2026-10-24 — Progress lines name Apify

When `APIFY_TOKEN` is set, the spoken thinking bar says "Using Apify…" / "Waiting on Apify…" / "Got Apify results from …" so the demo calls out the API. Without a token, wording stays generic.

## 2026-10-24 — Progress TTS is calm + declarative

`agent.say` with `kind: "progress"` still speaks (in-chat thinking bar). Cartesia was reading trailing `…` with rising question intonation. `speechForKind` in `voice.ts` strips trailing ellipses, ends with a period, and sets `generation_config.emotion` to `calm` for progress (`curious` for questions). Captions keep the original ellipsis text.

## 2026-10-24 — Apify external reviews via one Google Search run (D-APIFY)

Outside reviews: `prefetchApifySearch` runs **three Apify actors in parallel** (Reddit lite search, YouTube search, one Google SERP for articles only) under `APIFY_BUDGET_MS` (default 25 s), started as soon as the shopper query is known. We deliberately do **not** chain full transcript/page scrapes after discovery — that is the slow path; search snippets (+ YouTube description/captions when the actor returns them) feed Claude. Progress updates go to a single in-place thinking line and are spoken with calm/declarative TTS. Final shortlist is one `agent.say` with newlines.

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
