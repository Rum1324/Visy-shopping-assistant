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
  // Option 1's tab is the one in front, so it's the focused product.
  const title = agent.state?.shortlist[0]?.product.title ?? "";
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

test("a usual request picks the item it names, not the first saved usual", async () => {
  const prefs = preferenceStore(memoryPrefsDb());
  const userId = "shopper-2";
  const usual = (value: string, detail: string) =>
    prefs.upsertFact(userId, { id: `usual-${value}`, kind: "usual_item", value, detail, evidence: "Seeded past purchase.", confidence: 0.9, updatedAt: when });
  const bought = (productId: string, title: string, query: string) =>
    prefs.recordPurchase(userId, { productId, title, marketplace: "amazon", price: { cents: 599, currency: "USD" }, query, purchasedAt: when });
  await bought("amazon:B0SEAWEED1", "Roasted Seaweed Snacks, Sea Salt, 24 Pack", "seaweed snacks");
  await usual("amazon:B0SEAWEED1", "Roasted Seaweed Snacks, Sea Salt, 24 Pack");
  await bought("amazon:B0SUGAR001", "Granulated Sugar, 4 lb", "sugar");
  await usual("amazon:B0SUGAR001", "Granulated Sugar, 4 lb");
  await usual("amazon:B0POWER001", "Laptop Power Bank 25000mAh");

  for (const query of ["I'm out of sugar, get the usual", "the usual sugar", "sugar"]) {
    const hit = await prefs.recall(userId, query);
    assert.equal(hit.ok && hit.data.purchases[0]?.title, "Granulated Sugar, 4 lb", query);
    assert.equal(hit.ok && hit.data.facts.every((fact) => fact.value === "amazon:B0SUGAR001"), true, query);
  }
  const bank = await prefs.recall(userId, "get my usual power bank");
  assert.equal(bank.ok && bank.data.purchases.length, 0);
  assert.equal(bank.ok && bank.data.facts[0]?.detail, "Laptop Power Bank 25000mAh");
  // Nothing named: every usual, as before.
  const any = await prefs.recall(userId, "order the usual");
  assert.equal(any.ok && any.data.facts.length, 3);
  // Named but never bought: nothing, so Visy doesn't offer seaweed for coffee.
  const coffee = await prefs.recall(userId, "the usual coffee");
  assert.equal(coffee.ok && coffee.data.facts.length + coffee.data.purchases.length, 0);
});
