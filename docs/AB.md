# Tracks A and B — in progress

Branch: `ab/extension-and-agent`. Claimed 2026-10-24. Do not start a second extension or conversation agent.

Track C (navigator, Moss picker chain) is already on `main`. This branch does not rewrite it. The agent calls `Services` and uses `mockServices()` until someone swaps in the real navigator.

## Direction

**A — `apps/extension`.** Chrome side panel owns the WebSocket to `ws://localhost:8787`. Captions and an ARIA live region mirror `agent.say` and `session.snapshot`. Push-to-talk sends PCM to the server. A content script builds `PageState` and performs `Action`, and it never clicks `purchaseRisk`. The service worker keeps agent tabs in a "Visy" tab group.

**B — `apps/server` WebSocket.** Owns `SessionState`. Speaks the real `ClientMsg` / `ServerMsg` protocol (same port as the mock server; run one of them). Flow: acknowledge, search Amazon / Target / Walmart through `Services.navigator`, stream a shortlist of 3, answer a follow-up from `ReviewIndex`, add to cart, read back checkout, stop. No tool places an order.

**Voice.** Cartesia runs on the server. `CARTESIA_API_KEY` is read from `apps/server/.env` only. The extension never receives the key. Without the key, captions and typed text still work. Audio is proxied through this server (STT on `audio.end`, TTS bytes on each `agent.say`). A browser access token is a later option, not this branch.

**Secrets.** Copy new keys into the existing gitignored `apps/server/.env`. Do not commit `.env`, do not paste keys into chat, do not put them in the extension.

## Run

```bash
npm run server          # real agent, ws://localhost:8787
npm run mock-server     # fixtures only; stop the real server first
```

Load `apps/extension` as an unpacked extension. Side panel: type "picnic blanket", or hold the mic button.


## Working on this branch

- Type or hold the mic. Cartesia transcribes on the server and speaks the replies. Progress lines stay on screen and are not all spoken, so the shortlist is not buried under status chatter.
- "picnic blanket" searches the three stores through `Services` (mocks until Track C is swapped in) and speaks an accessibility line when the reviews have one.
- "is the backing waterproof?" answers from the review index. Review text is quoted, not obeyed.
- "under $20" filters the shortlist. "add option 1" reads checkout back and stops. "yes" checks that total and still does not press Place order. The side panel has Stop, and a button that sends `checkout.confirm` for the total that was read back.
- The extension reconnects if the server is not up yet.

## Not this branch

Picker bake-off, Playwright shopping, Apify reviews, and replacing `mockServices()` with Track C. Contract changes stay additive. `npm test` must pass.
