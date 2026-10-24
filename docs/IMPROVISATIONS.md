# Improvisations

Living log of changes that depart from the skeleton in `docs/ARCHITECTURE.md`, `docs/HANDOFF.md`, and `packages/contracts`. Newest entries go first.

If you improvise, add an entry in the same commit and push it. Say what changed, why the skeleton was not enough, and what other agents should do differently now.

## 2026-10-24 — Working agreement, no product deviation

The project is high-paced. Agents may leave the skeleton when it blocks the work, as long as the departure is written here and pushed.

Cloud Agent setup follows the skeleton as it exists today: `npm ci`, `npm test`, `npm run typecheck`, and `npm run mock-server` on port 8787. `apps/extension` and `apps/server` are not in the repo yet. Secrets in `.env.example` stay unused until that server exists.
