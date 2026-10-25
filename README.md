# Visy: Shop at the speed of your voice

A voice-first shopping assistant for blind and low-vision shoppers. Tell Visy what you need: it asks a few questions, searches Amazon, Target and Walmart in your own signed-in Chrome, and reads you three picks (best match, best value, most trusted). Ask what a product looks like or what reviewers say. Visy adds your pick to the cart and stops at checkout. **You press the final button.**

Demo video: https://youtu.be/3mJRvwUcNzI · Devpost write-up: [docs/DEVPOST-SUBMISSION.md](docs/DEVPOST-SUBMISSION.md)

## How it works

- **Chrome extension** (`apps/extension`): side panel with live captions and mic, plus the hands that read and click pages in a dedicated "Visy" tab group.
- **Server brain** (`apps/server`): Claude Haiku 5.5 runs the conversation, picks the top 3 and summarizes reviews. **Moss** picks most clicks in ~4 ms, so Claude is a fallback, not the first step. **Cartesia** handles speech in and out, **Apify** fetches Reddit, YouTube and article reviews, and **Convex** remembers your preferences and "the usual".
- **Safety in code:** Visy never clicks purchase buttons, treats page and review text as untrusted data, and hands CAPTCHAs to you.

## Run it

Requires Node 22+.

```bash
npm install
npm test             # contracts, safety rules, picker bench
npm run server       # real server (needs Anthropic, Moss, Cartesia, Convex keys)
npm run mock-server  # fake server on ws://localhost:8787, no keys needed
```

Then load `apps/extension` as an unpacked extension in `chrome://extensions` and open the Visy side panel.

## For contributors

> **Hackathon project:** speed over polish. See [CLAUDE.md](CLAUDE.md); the safety rules still apply.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system design, browser agent, safety
- [docs/HANDOFF.md](docs/HANDOFF.md): team tracks and handoff rules
- [packages/contracts](packages/contracts): shared schemas (zod), fixtures, mocks and mock server. **Start here.**
- [docs/IMPROVISATIONS.md](docs/IMPROVISATIONS.md): log of departures from the plan. See [AGENTS.md](AGENTS.md).
- [apps/server/README.md](apps/server/README.md): benches, demos and measured speedups
