# Hackathon log

- **Project:** Visy
- **Event:** Cal Hacks 13.0
- **What it does:** A voice-first Chrome extension that lets visually impaired shoppers search, compare, remember and cart products on Amazon, Walmart and Target, and stops before the final purchase button.
- **Live app:** not deployed (local server plus an unpacked Chrome extension)
- **Repo:** https://github.com/Rum1324/Visy-shopping-assistant
- **Frontend:** Other (Chrome extension side panel, `apps/extension`)
- **Convex deployment:** Convex cloud via `npm run convex:deploy`; the URL lives in server env, not in the repo
- **Components:** none
- **Convex features:** schema, indexes, queries, mutations
- **Auth:** none
- **AI models:** claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5
- **Started:** 2026-10-24T12:25:48Z
- **Last updated:** 2026-10-25T11:56:34Z

## How we use Convex

Convex is Visy's memory. A blind shopper can't scroll an order history, so "get the usual" has to come from a database row, not the screen.

- **"I'm out of sugar, get the usual":** `recall` reads `facts` and `purchases` through the `prefs.list` query on the `by_user` index, then offers the named item for the cart. Files: `apps/server/convex/prefs.ts`, `apps/server/src/prefs.ts`.
- **"Remember this":** saves the focused product as a `usual_item` fact via the `upsertFact` mutation, which patches in place, so a repeat save never duplicates it. Files: `apps/server/convex/prefs.ts`, `apps/server/src/agent.ts`.
- **Lasting preferences:** favorite stores and brands, and price vs quality vs shipping speed, are saved by `remember_preference` and loaded by `getProfile` at session start to shape later searches. Files: `apps/server/src/saved-prefs.ts`, `apps/server/test/remember-pref.test.ts`.
- **Typed, indexed data:** two tables with `by_user` and `by_user_*` indexes; rows are parsed with the shared zod contracts on read. Files: `apps/server/convex/schema.ts`, `apps/server/src/prefs-convex.ts`.
- **Demo seed via the app's own path:** past purchases are written by the same `recordPurchase` mutation the app uses. File: `apps/server/src/seed-prefs.ts`.
- **What updates live:** no screen uses a Convex subscription. The side panel updates without a refresh over the server's WebSocket `session.snapshot`; Convex is read through `ConvexHttpClient`.

## Log

- 10-24 `0e549fa` Architecture and shared contracts (`docs/ARCHITECTURE.md`, `packages/contracts`)
- 10-24 `e1d2e16` Navigator MVP: Moss picker, Claude fallback (`apps/server/bench`)
- 10-24 `c1e39ef` First spoken demo loop (`sidepanel.js`, `agent.ts`)
- 10-24 `5778abe` Act while page streams: Amazon 11.3 s to 3.4 s (`driver/playwright.ts`)
- 10-24 `9abe056` Plan: the usual item is a Convex row (`docs/TRACKS-B.md`)
- 10-24 `c78d226` Convex schema, list query, upsert mutations (`convex/schema.ts`, `convex/prefs.ts`)
- 10-24 `8c89b6a` Claude tool loop per turn (`agent-tools.ts`)
- 10-24 `b5c57eb` Never send password, card or OTP values (`indexer.ts`)
- 10-24 `062e7db` Review synthesis, photo descriptions (`intel/claude.ts`)
- 10-24 `6bcf0a3` Ask 2-3 questions, narrow to 3 (`narrow.ts`)
- 10-24 `604e4c1` remember_preference saves to Convex (`saved-prefs.ts`)
- 10-24 `30990eb` Live Walmart search (`navigator/scripts.ts`)
- 10-24 `763b669` Live Target search (`sites/target.ts`)
- 10-24 `6ec1296` Apify Reddit/YouTube reviews (`intel/apify.ts`)
- 10-24 `fcd32ca` Hands-free voice, barge-in (`mic.js`)
- 10-24 `0ea25a7` Target add to cart and read-back (`sites/target.ts`)
- 10-24 `feefe40` Drop loaded-language reviews (`intel/reviews.ts`)
- 10-25 `e1456b7` Claude relevance filter (`relevance.ts`)
- 10-25 `d0c4820` Read reviews before picking (`narrow.ts`)
- 10-25 `2094201` Each site's own price filter (`search-urls.ts`)
- 10-25 `9abf8b1` Recall the named usual from Convex (`prefs.ts`, `seed-prefs.ts`)
- 10-25 `923f0f2` Voice up to 3× without pitch shift (`sidepanel.js`)
- 10-25 `31188b9` Nearly Natural as a 4th store (`nearlynatural.ts`)
