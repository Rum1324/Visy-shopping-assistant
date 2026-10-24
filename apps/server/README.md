# Navigator MVP (Track C): Moss-first, Claude-fallback

Element picking for the browser agent, fastest first:

```
0. shortcut URL + deterministic extraction (amazon.com/s?k=…)          no AI
1. memory  Moss session of past successful picks, saved to data/        ~5 ms
2. moss    per-page local Moss session over PageState.elements          index once per page, ~1–10 ms per query
3. claude  CLAUDE_PICKER_MODEL picks from the element list              ~1–3 s, result written back to memory
```

Purchase buttons (`purchaseRisk`) are never candidates. Bot checks return `err("blocked")`; the human solves them in the window.

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
