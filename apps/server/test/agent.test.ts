import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMsg } from "@visy/contracts";
import { fixtures } from "@visy/contracts/fixtures";
import { mockServices } from "@visy/contracts/mocks";
import { createAgent, type AgentSink } from "../src/agent.ts";
import { Cartesia } from "../src/voice.ts";

function harness() {
  const said: string[] = [];
  const sent: ServerMsg[] = [];
  const sink: AgentSink = {
    send: (msg) => sent.push(msg),
    say: async (text) => {
      said.push(text);
    },
    stopSpeaking() {},
  };
  const agent = createAgent(mockServices({ latencyMs: 0 }), sink);
  return { agent, said, sent };
}

test("cartesia is off when the key is empty", () => {
  assert.equal(new Cartesia("").enabled, false);
});

test("picnic blanket streams three options and does not check out", async () => {
  const { agent, said, sent } = harness();
  await agent.hello("demo-user");
  await agent.handleText("picnic blanket");
  assert.equal(agent.state?.phase, "presenting");
  assert.equal(agent.state?.shortlist.length, 3);
  assert.match(said.join(" "), /Amazon/);
  assert.match(said.join(" "), /Target/);
  assert.match(said.join(" "), /Walmart/);
  assert.equal(sent.some((m) => m.type === "checkout.confirmRequired"), false);
});

test("the usual seaweed is recalled and no order is placed", async () => {
  const { agent, said } = harness();
  await agent.hello("demo-user");
  await agent.handleText("order the usual seaweed");
  assert.match(said.join(" "), /Seaweed/);
  assert.notEqual(agent.state?.phase, "done");
  assert.equal(agent.state?.checkout, undefined);
});

test("checkout confirm checks the total and still refuses to press Place order", async () => {
  const { agent, said, sent } = harness();
  await agent.hello("demo-user");
  await agent.handleText("picnic blanket");
  await agent.handleText("add option 1");
  assert.equal(agent.state?.phase, "checkout_review");
  assert.equal(sent.some((m) => m.type === "checkout.confirmRequired"), true);
  assert.match(said.at(-1) ?? "", /will not place the order/i);

  await agent.confirm({ cents: 1, currency: "USD" });
  assert.equal(agent.state?.phase, "checkout_review");

  await agent.confirm(fixtures.checkout.total);
  assert.equal(agent.state?.phase, "done");
  assert.match(said.at(-1) ?? "", /will not press Place order/i);
});

test("a follow-up question is answered from reviews and does not check out", async () => {
  const { agent, said } = harness();
  await agent.hello("demo-user");
  await agent.handleText("picnic blanket");
  await agent.handleText("is the backing waterproof?");
  assert.equal(agent.state?.phase, "presenting");
  assert.match(said.at(-1) ?? "", /waterproof/i);
  assert.equal(agent.state?.cart.length, 0);
});

test("under a dollar keeps the shortlist and does not shop again", async () => {
  const { agent, said } = harness();
  await agent.hello("demo-user");
  await agent.handleText("picnic blanket");
  await agent.handleText("under $1");
  assert.match(said.at(-1) ?? "", /Nothing on the shortlist/i);
  assert.equal(agent.state?.shortlist.length, 3);
});

test("saying yes confirms the read-back total and still does not place the order", async () => {
  const { agent, said } = harness();
  await agent.hello("demo-user");
  await agent.handleText("picnic blanket");
  await agent.handleText("add option 1");
  await agent.handleText("yes");
  assert.equal(agent.state?.phase, "done");
  assert.match(said.at(-1) ?? "", /will not press Place order/i);
  assert.equal(agent.state?.cart[0]?.quantity, 1);
});

test("an instruction buried in a later utterance still adds only one", async () => {
  const { agent } = harness();
  await agent.hello("demo-user");
  await agent.handleText("picnic blanket");
  await agent.handleText("add 10 to cart");
  assert.equal(agent.state?.cart.length, 1);
  assert.equal(agent.state?.cart[0]?.quantity, 1);
  assert.notEqual(agent.state?.phase, "done");
});
