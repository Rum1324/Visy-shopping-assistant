# Improvisations

Living log of changes that depart from the skeleton in `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, and `packages/contracts`. Newest entries go first.

If you improvise, add an entry in the same commit and push it. Say what changed, why the skeleton was not enough, and what other agents should do differently now.

## 2026-10-25 — Ctrl+M mute hotkey

Side panel: `Ctrl+M` / `Cmd+M` toggles the mic (same as the button / voice mute). While muted, a banner and input placeholder say "Muted. Press Ctrl+M to unmute." Works only while the side panel is focused (not a Chrome global command).

## 2026-10-25 — Voice/text mute and voice-speed (UX-SPEED-VOICE)

Users can say/type mic mute (`mute`, `stop listening`) and unmute (`unmute`, `start listening` — type when muted), same as the mic button. Parsed in `mic-mute.ts` before Claude; `set_mic_muted` tool as backup. Server confirms, then `settings.changed.micMuted` so the side panel calls `setMicOn`. Same pattern as voice speed (`speak faster`, `change the voice speed`, `set_speech_rate` → `settings.changed.speechRate`). Other agents: never refuse mute/speed in free text; don't match "mute colors" / "faster shipping".

## 2026-10-25 — Voice/text voice-speed commands (UX-SPEED-VOICE)

UX-SPEED only had a Settings slider. Users can say or type speed commands (`speak faster`, `slow down`, `change the voice speed`, `set voice speed to 1.5`, `2x`). Parsed in `speech-rate.ts` before Claude; vague "change voice speed" asks faster/slower/a number. Also `set_speech_rate` tool so Claude never invents "I can't change voice speed / use your screen reader". Server applies the rate, confirms, and sends additive `settings.changed` for slider + `localStorage` + WSOLA. Other agents: don't match "faster shipping"; never refuse TTS speed in free text.

## 2026-10-25 — "The usual" names the item and goes to the cart (B-USUAL)

"I'm out of sugar, get the usual" used to say the first saved usual (always seaweed) and stop, because any query with "usual" returned every usual item. Now `select()` in `prefs.ts` drops filler words ("get", "the", "usual", "out"…) and, when an item is named, returns only the usuals and purchases that mention it; with nothing named it still returns all usuals. `recallUsual` puts the item up as a one-item shortlist, opens its product page (`getDetail`, which the live Amazon cart needs), and asks "Want me to add it to your cart?"; the next turn's yes or "add it" goes straight to `addToCart` and the normal checkout read-back, no model call. `npm run seed-prefs` now also seeds a real Amazon sugar canister (`B01JA9KAOM`) for the demo video's cold open. Other agents: pass the item the user named as `recall_usual`'s query.

## 2026-10-25 — Bounded Reddit thread deepen after Google

Google still discovers Reddit URLs (`site:reddit.com` SERP). After Q&A unlocks on snippets, `enrichWithReddit` runs `trudax~reddit-scraper-lite` on ≤2 URLs/product (≤6 total), max 25 comments, ~25 s (`APIFY_REDDIT_BUDGET_MS`), then YouTube enrich. Replaces SERP snippets with post+comment text when the actor returns. Does not block the first external answer.

## 2026-10-25 — External answers must not lead with Amazon stars

Outside Q&A was mixing product `rating`/`reviewCount` into Claude’s tool payload, so answers sounded like Amazon blurbs even when Apify had Reddit SERP hits. External asks now omit retailer rating/description and must use only external summary/pros/cons + source line. Still: Apify does **not** scrape full Reddit threads — only Google title+snippet text.

## 2026-10-25 — Don't apologize that outside reviews are "snippets"

Apify only pulls Google SERP text for Reddit/YouTube/articles (not full thread bodies). We were injecting that as a synthesis warning, and Claude read it aloud (“short search snippets, not full retailer reviews”) even when Reddit hits existed. Stop injecting/speaking that; cite sources instead (`Reviews from Reddit…`).

## 2026-10-25 — Stale shortlist after external wait

After `waitExternal`, answers still read the **pre-wait** shortlist object, so `externalReviews` looked missing and Claude said “still gathering” even when Apify+synth had finished. Re-read `state.shortlist` after the wait. Cap 90 s (Google often 35–70 s). Biggest wall time: Apify Google Search Scraper.

## 2026-10-25 — Don't block external Q&A on YouTube enrich

`waitExternal` used to wait until Google **and** the shared YouTube actor finished (YouTube only starts after all three Google runs — often 30–90 s of "Reading the reviews"). Ready now unlocks after that option's Google hits are synthesized; YouTube may refresh `externalReviews` later.

## 2026-10-25 — Outside reviews: quote the model key, speak the findings

Quoted `"ASUS rtx 5060"` missed real SERP titles like “ASUS Dual GeForce RTX 5060”. Queries now use brand loose + model quoted (`ASUS "rtx 5060"`). Synthesis must put product findings in summary/pros/cons (not “reviews are short snippets”); meta goes in warnings. Keyword “more info” answers speak summary + pros + cons + sources. Non-Ti products reject Ti sibling hits (`rtx 5060` ⊂ `rtx 5060 ti`).

## 2026-10-25 — Outside reviews must name the exact model

Apify hits were kept if they mentioned the **brand** (first word), so “Zotac RTX 4070” leaked into a 5060 Ti option. Now: `modelKeys` pulls fingerprints (`rtx 5060 ti`, `wh-1000xm5`), Google/YouTube queries quote the model key (not brand+model as one phrase), and `hitMatchesProduct` drops snippets that don’t include a model key (soft goods still need two phrase words).

## 2026-10-25 — Concurrent Apify per shortlist option

Outside reviews: **three parallel** Google Search Scraper calls (one product each, `hedge: false` so we stay under Apify’s 5 concurrent-run cap). Each option synthesizes as soon as *its* call returns. Then one shared YouTube enrich. Status bar stays through presenting; follow-ups wait up to 120 s. Reload the extension after pulling.

## 2026-10-25 — Apify starts at shortlist; per-option ready

Apify was waiting for all three `getDetail`s, then one big scrape+synth — so “external reviews for option 1” felt stuck. Now: Google scrape starts the moment the shortlist is known (parallel with speaking). Option 1 is scraped first. Asking about option 1 waits only on that product’s promise. YouTube can still refresh afterward.

## 2026-10-25 — Amazon Renewed badge was the "product name"

Search cards often put **Amazon Renewed** (or Sponsored / Choice) in the first `h2`, so the shortlist said "Amazon Renewed" and Apify queried that. Fix: `amazon.results` takes the `/dp/` link aria-label or longest non-badge span; `cleanListingTitle` strips badge prefixes for spoken names and Apify; Apify waits for product-page titles before searching. Re-run `npm run gen-indexer -w @visy/server` and reload the extension after pulling.

## 2026-10-25 — Retailer pitch, Apify external in background (D-APIFY-BUDGET)

Shortlist **spoken descriptions use retailer reviews only** (fast). When the three picks are known, Apify runs in the **background**: parallel Google per option, then bounded Reddit thread deepen + YouTube. Results land on `ShortlistItem.externalReviews` (additive). Follow-ups use that synthesis. Budgets: Google 60–90 s, Reddit deepen ~25 s. Other agents: don't mix Apify into the initial pitch; keep Reddit/YouTube sequential after Google so we stay under the 5-run cap.

## 2026-10-25 — Longer Apify budgets (superseded by retailer/external split above)

Earlier pass raised Google budgets only. Behavior above replaces waiting on Apify during the shortlist reading.

## 2026-10-25 — Claude relevance filter before narrowing (B-RELEVANCE)

Marketplace keyword search returns near-misses (query "avocado" → avocado oil). After scraping Amazon/Target/Walmart, `haikuRelevance()` in `relevance.ts` sends titles to Haiku and keeps only products that *are* what the shopper asked for; then `narrowToThree` runs on that pool. Offline tests pass a `relevance` filter into `createAgent`. API failure fails open (keeps the pool); a deliberate empty keep list means "nothing matched" and Visy says so. Other agents: don't keyword-filter titles in site scrapers for this; the Claude gate is the cross-marketplace fix.

## 2026-10-24 — Pause stays paused when focusing the text box (UX-PAUSE)

`pauseAll()` suspends `audioCtx` and sets `paused`. The side panel also resumes `audioCtx` on any `pointerdown` and on `#text` focus (Chrome autoplay unlock). That un-paused the speakers while leaving `paused === true`, so caption reveal stayed frozen (voice with no on-screen text). Fix: only call `audioCtx.resume()` from those unlock paths and from `playPcm` when `!paused`. After A-STT, `pointerdown` still resumes `micCtx`/`toneCtx` and calls `maybeListen()` (gated on `!paused`). Explicit Resume / submit still go through `resumeAll()`.

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
