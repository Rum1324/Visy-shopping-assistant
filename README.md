# Visy: the fastest browser agent specialized for shopping

A voice-first shopping assistant for visually impaired users. Chrome extension (eyes, hands and voice) plus a TypeScript server (Claude agent, Jev and Moss browser pickers, Cartesia voice, review synthesis).

> **Hackathon project:** speed over polish. Don't over-engineer for cleanliness or extensibility. See [CLAUDE.md](CLAUDE.md); the safety rules still apply.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): platform decision, system design, flow, browser agent, safety
- [docs/HANDOFF.md](docs/HANDOFF.md): team tracks, data handoff rules, checkpoints
- [docs/AB.md](docs/AB.md): Tracks A and B, in progress on `ab/extension-and-agent`
- [packages/contracts](packages/contracts): the shared schemas (zod), fixtures, mocks and mock server. **Start here.**

```bash
npm install
npm test             # contracts + fixtures + mock flow
npm run mock-server  # fake server on ws://localhost:8787 speaking the real protocol
```

Requires Node 22+.
