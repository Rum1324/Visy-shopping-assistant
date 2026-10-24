# Agent notes

## Pace

This is a very high-paced project. `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, and `packages/contracts` are the skeleton. When that skeleton blocks a demo or a track, improvise and keep moving.

Write every improvisation in [docs/IMPROVISATIONS.md](docs/IMPROVISATIONS.md) in the same change, and push that change to GitHub. Other agents catch up from that log. A deviation that lives only in chat does not count.

Keep `npm test` passing on `main`. If a change breaks a handoff rule (rename, remove, or tighten a contract field), put that at the top of the log entry. Bump `CONTRACT_VERSION` only when the wire format actually changes.

## Claim tasks in TODO.md

Before touching a task, `git pull` and read [TODO.md](TODO.md). Claim an `[open]` line by changing it to `[working]` with owner, branch and time, commit only that file (`claim: <ID>`), and push to `main` right away. If the push is rejected, rebase and re-read: the first claim wins. Never work on a `[working]` task that isn't yours. Mark it `[done]` with the PR link when it merges.

## Cursor Cloud specific instructions

- Node 22+ is required (`engines` in the root `package.json`). The default image already provides it on the login-shell `PATH`.
- Install from the repo root: `npm ci`. This is an npm workspaces repo. Today the only workspace is `@visy/contracts`.
- Checks: `npm test` and `npm run typecheck`.
- Dev server: `npm run mock-server` speaks the real wire protocol on `ws://localhost:8787`. It needs no API keys. `.env.example` is for a future `apps/server`, which is not in the tree yet.
- Hello-world: connect to the mock server, send `{"type":"hello","protocol":1,"userId":"demo","client":"extension"}`, then `{"type":"user.text","text":"picnic blanket"}`. Expect a welcome, clarifying questions, Amazon/Target/Walmart progress, and three spoken shortlist options, ending in session phase `presenting`.
- `{"type":"user.text","text":"driver test"}` emits `driver.request` messages for the content-script driver.
