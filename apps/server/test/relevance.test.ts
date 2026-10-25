import assert from "node:assert/strict";
import { test } from "node:test";
import { Need, type ProductCandidate } from "@visy/contracts";
import { mockServices } from "@visy/contracts/mocks";
import { createAgent, type AgentSink } from "../src/agent.ts";
import { rejectTitleRelevance } from "../src/relevance.ts";

const need = Need.parse({ query: "avocado", marketplaces: ["amazon"] });

function cand(id: string, title: string): ProductCandidate {
  return {
    id: `amazon:${id}`,
    marketplace: "amazon",
    url: `https://www.amazon.com/dp/${id}`,
    title,
    price: { cents: 499, currency: "USD" },
    imageUrls: [],
    source: { via: "fixture", confidence: 1, fetchedAt: new Date().toISOString() },
  };
}

const avocadoPool = [
  cand("AVO1", "Fresh Hass Avocados, Bag of 4"),
  cand("OIL1", "Chosen Foods 100% Pure Avocado Oil, 1 Liter"),
  cand("AVO2", "Organic Whole Avocado, Each"),
  cand("SOAP1", "Avocado Oil Body Wash, Moisturizing"),
];

test("relevance: rejectTitleRelevance drops oil/soap near-misses for avocado", async () => {
  const filter = rejectTitleRelevance(/\b(oil|shampoo|body wash|soap)\b/i);
  const kept = await filter(need, avocadoPool);
  assert.deepEqual(
    kept.map((c) => c.id),
    ["amazon:AVO1", "amazon:AVO2"],
  );
});

test("shop: relevance filter runs before narrowing so oil never makes the shortlist", async () => {
  const services = mockServices({ latencyMs: 0 });
  // One marketplace only so the pool size is the avocado fixture, not ×3.
  services.navigator.search = async (_need, marketplace) =>
    marketplace === "amazon" ? { ok: true, data: avocadoPool } : { ok: true, data: [] };
  const said: string[] = [];
  const sink: AgentSink = {
    send() {},
    async say(text) {
      said.push(text);
    },
    stopSpeaking() {},
  };
  const agent = createAgent(services, sink, {
    llm: null,
    jev: null,
    clarify: false,
    relevance: rejectTitleRelevance(/\b(oil|shampoo|body wash|soap)\b/i),
  });
  await agent.hello("demo-user");
  await agent.handleText("avocado");
  assert.equal(agent.state?.phase, "presenting");
  assert.ok(agent.state!.shortlist.length >= 1);
  assert.ok(agent.state!.shortlist.every((item) => !/\boil\b/i.test(item.product.title)));
  assert.ok(agent.state!.shortlist.every((item) => /avocado/i.test(item.product.title)));
  assert.match(said.join(" "), /I found 2 products/i);
});

test("shop: when nothing is relevant, Visy says so and does not present oil", async () => {
  const services = mockServices({ latencyMs: 0 });
  services.navigator.search = async (_need, marketplace) =>
    marketplace === "amazon"
      ? {
          ok: true,
          data: [cand("OIL1", "Chosen Foods 100% Pure Avocado Oil, 1 Liter"), cand("SOAP1", "Avocado Oil Body Wash")],
        }
      : { ok: true, data: [] };
  const said: string[] = [];
  const sink: AgentSink = {
    send() {},
    async say(text) {
      said.push(text);
    },
    stopSpeaking() {},
  };
  const agent = createAgent(services, sink, {
    llm: null,
    jev: null,
    clarify: false,
    relevance: rejectTitleRelevance(/\b(oil|body wash)\b/i),
  });
  await agent.hello("demo-user");
  await agent.handleText("avocado");
  assert.equal(agent.state?.phase, "idle");
  assert.equal(agent.state?.shortlist.length, 0);
  assert.match(said.at(-1) ?? "", /none looked like what you asked for/i);
});
