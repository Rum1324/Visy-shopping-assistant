# Visy: the fastest browser agent specialized for shopping

A voice-first shopping assistant for visually impaired users. Chrome extension (eyes, hands and voice) plus a TypeScript server (Claude agent, Jev and Moss browser pickers, Cartesia voice, review synthesis).

## How we use Convex

- Convex is Visy's memory: usual items, past purchases and stated preferences live in two indexed tables ([schema.ts](apps/server/convex/schema.ts)).
- "Get the usual" runs the `prefs.list` query and "remember this" runs the `upsertFact` mutation ([prefs.ts](apps/server/convex/prefs.ts)).
- Saved stores, brands and priorities load at session start and shape every later search.
- Full evidence, features and the commit log for Cal Hacks 13.0: [hackathon.md](hackathon.md).

> **Hackathon project:** speed over polish. Don't over-engineer for cleanliness or extensibility. See [CLAUDE.md](CLAUDE.md); the safety rules still apply.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): platform decision, system design, flow, browser agent, safety
- [docs/HANDOFF.md](docs/HANDOFF.md): team tracks, data handoff rules, checkpoints
- [docs/AB.md](docs/AB.md): Tracks A and B, in progress on `ab/extension-and-agent`
- [packages/contracts](packages/contracts): the shared schemas (zod), fixtures, mocks and mock server. **Start here.**
- [docs/IMPROVISATIONS.md](docs/IMPROVISATIONS.md): living log of departures from the skeleton. This project moves very fast. Improvise when the skeleton blocks the demo, write the change there, and push it so the next agent can catch up. See [AGENTS.md](AGENTS.md).

```bash
npm install
npm test             # contracts + fixtures + mock flow
npm run mock-server  # fake server on ws://localhost:8787 speaking the real protocol
```

Requires Node 22+.
