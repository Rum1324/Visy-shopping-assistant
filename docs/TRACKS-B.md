# Track B: the usual item lives in a database (revised 2026-10-24)

> Hackathon rules apply ([CLAUDE.md](../CLAUDE.md)). This replaces the PreferenceStore part of the B row in [HANDOFF.md](HANDOFF.md). Tracks C and D are unchanged ([TRACKS-CD.md](TRACKS-CD.md)).

## Decision

"The usual seaweed" is not a string in the agent. **Convex holds the profile. Moss recalls it.**

Convex is the Cal Hacks database that matches this repo: TypeScript, documents, server functions, and a Saturday workshop ("Build Your Backend with Convex"). Best use of Convex is $5,000. The tables are the types already in `packages/contracts/src/prefs.ts`: `UserProfile`, `PreferenceFact`, `PurchaseRecord`.

Moss is the lookup, which is what [ARCHITECTURE.md](ARCHITECTURE.md) §5 already assigned to `PreferenceStore`. Best Use of Moss calls out a personal agent that remembers you. Moss is not the system of record. An embedding index is not a purchase log.

The agent keeps calling `PreferenceStore` in `services.ts`. Tests keep `mockPreferenceStore()`. `PREFS=convex` swaps in the real one. `CONVEX_URL` and the deploy key stay in gitignored `apps/server/.env`. The extension never sees them.

## What the demo does

1. Before the stage, a seed script calls `recordPurchase` for demo-user. That insert is a real Convex row, written by the same function the app uses. The agent source has no seaweed title in it.
2. On stage, "order the usual" recalls that row through Moss and speaks the title and price. It does not search and it does not check out.
3. When the user says "remember this" about a shortlist item, or confirms a checkout read-back, B writes a `usual_item` fact. The spoken line says Visy saved it and did not place the order. `purchasedAt` is set only for a purchase the user says already happened, or for the seeded row.

The fixture profile in `packages/contracts` stays. It is the test double, not the demo.

## Sponsors considered

| Sponsor | What they give | Use for this? |
|---|---|---|
| **Convex** | Database, functions, sync, search. All TypeScript. $5,000. | **Yes. Source of truth.** |
| **Moss** | Retrieval in a few milliseconds. Personal-agent example is "remembers you". AirPods Max. | **Yes. Recall only.** Already linked from the server for Track C's picker. |
| **Visa, Reimagining Shopping** | $5,000. Judged on shopping UX, loyalty, and trust. | **Why this demo beat exists.** Not where the row is stored. |
| SpacetimeDB | Real-time SQL, subscriptions, server logic. $2,048 / $1,024 / $512. | No. Built for shared live state across users. One shopper's profile does not need it. Runner-up if Convex is down. |
| Elastic | Agent research over a corpus. Quest 3S / Bose. | No. That job is closer to D's review index. A third system for a handful of preference rows is wasted. |
| Cartesia | Voice. Already in the product. | No. Not storage. Keep using it for speech. |
| Apify, Bright Data | Live public web data. | No. Those feed C and D (pages and reviews). Bright Data also disqualifies a demo that still shows mocked data, which is another reason the live "usual" cannot be the fixture. |

## Track B plan, in order

| # | Item | Done when |
|---|---|---|
| B1 | `convexPreferenceStore()` behind `PreferenceStore`. `PREFS=convex`, otherwise the mock. | A unit test against a fake Convex client round-trips `upsertFact`, `recordPurchase`, and `recall` without the fixture seaweed string in `agent.ts`. |
| B2 | Writes from the conversation. "Remember this" saves a `usual_item` fact for the focused product. Checkout confirm can do the same. Speech says the order was not placed. | After confirm, a new Convex fact exists and the cart was not purchased by the agent. |
| B3 | Moss recall. Index `title`, `query`, `detail`, and `evidence` on each write. `recall` queries Moss, then loads the Convex row. Delete the `usual\|seaweed` phrase match. | "The usual" and "order the usual seaweed" both return the seeded row. An unrelated sentence does not. |
| B4 | `apps/server` seed script, run once before the demo, calling `recordPurchase`. | Restarting the server still remembers. Wiping the Convex deployment forgets, until the script is run again. |

C does not own this. C touches the browser. D does not own this. D turns reviews into answers. A only speaks what B sends.
