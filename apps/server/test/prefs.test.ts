import assert from "node:assert/strict";
import { test } from "node:test";
import { mockServices } from "@visy/contracts/mocks";
import { createAgent, type AgentSink } from "../src/agent.ts";
import { memoryPrefsDb, preferenceStore } from "../src/prefs.ts";

const when = "2026-10-24T20:00:00Z";

test("preference store round-trips a usual item that is not a fixture", async () => {
  const prefs = preferenceStore(memoryPrefsDb());
  const userId = "shopper-1";
  const fact = await prefs.upsertFact(userId, {
    id: "u1",
    kind: "usual_item",
    value: "amazon:B0OATMILK1",
    detail: "Oat milk, 64 oz",
    evidence: "remember this",
    confidence: 1,
    updatedAt: when,
  });
  const purchase = await prefs.recordPurchase(userId, {
    productId: "amazon:B0OATMILK1",
    title: "Oat milk, 64 oz",
    marketplace: "amazon",
    price: { cents: 499, currency: "USD" },
    query: "oat milk",
    purchasedAt: when,
  });
  assert.equal(fact.ok, true);
  assert.equal(purchase.ok, true);
  const hit = await prefs.recall(userId, "order the usual");
  assert.equal(hit.ok, true);
  if (!hit.ok) return;
  assert.equal(hit.data.purchases[0]?.title, "Oat milk, 64 oz");
  assert.equal(hit.data.facts[0]?.kind, "usual_item");
  const miss = await prefs.recall(userId, "picnic blanket");
  assert.equal(miss.ok, true);
  if (!miss.ok) return;
  assert.equal(miss.data.purchases.length, 0);
  assert.equal(miss.data.facts.length, 0);
});

test("remember this saves the focused product and a later usual recalls it", async () => {
  const said: string[] = [];
  const sink: AgentSink = {
    send() {},
    say: async (text) => {
      said.push(text);
    },
    stopSpeaking() {},
  };
  const services = mockServices({ latencyMs: 0 });
  services.prefs = preferenceStore(memoryPrefsDb());
  const agent = createAgent(services, sink, { clarify: false });
  await agent.hello("demo-user");
  await agent.handleText("picnic blanket");
  const title = agent.state?.shortlist.at(-1)?.product.title ?? "";
  assert.ok(title);
  await agent.handleText("remember this");
  assert.match(said.at(-1) ?? "", /saved that as your usual/i);
  assert.match(said.at(-1) ?? "", /did not place an order/i);
  await agent.handleText("order the usual");
  assert.match(said.at(-1) ?? "", new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.notEqual(agent.state?.phase, "done");
  assert.equal(agent.state?.checkout, undefined);
  const profile = await services.prefs.getProfile("demo-user");
  assert.equal(profile.ok && profile.data.facts.some((fact) => fact.kind === "usual_item"), true);
});
