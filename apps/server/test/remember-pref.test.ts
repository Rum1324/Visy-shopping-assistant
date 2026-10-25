import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { ServerMsg } from "@visy/contracts";
import { mockServices } from "@visy/contracts/mocks";
import { createAgent, type AgentSink } from "../src/agent.ts";
import type { Llm } from "../src/agent-tools.ts";
import { memoryPrefsDb, preferenceStore } from "../src/prefs.ts";

const reply = (content: unknown[]): Anthropic.Message =>
  ({ id: "m", type: "message", role: "assistant", model: "fake", content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }) as unknown as Anthropic.Message;
const use = (name: string, input: Record<string, unknown>) => reply([{ type: "tool_use", id: `tu_${name}`, name, input }]);

/** Stands in for Claude: a lasting preference becomes remember_preference, anything else a search. Records each turn message. */
function fakeClaude() {
  const turns: string[] = [];
  const llm: Llm = {
    messages: {
      async create(body) {
        const last = body.messages.at(-1)!;
        if (typeof last.content !== "string") return reply([]); // after a tool: nothing more to say
        turns.push(last.content);
        const said: string = JSON.parse(last.content.split("User said: ")[1]!).toLowerCase();
        const store = said.match(/always shop at (\w+)/)?.[1];
        if (store) return use("remember_preference", { kind: "favorite_marketplace", value: store });
        if (/fast shipping/.test(said)) return use("remember_preference", { kind: "priority", value: "shipping speed" });
        if (/favorite brand/.test(said)) return use("remember_preference", { kind: "favorite_brand", value: "Anker" });
        return use("search", { query: said, skipQuestions: true });
      },
    },
  };
  return { llm, turns };
}

function session(prefs = preferenceStore(memoryPrefsDb())) {
  const said: string[] = [];
  const sent: ServerMsg[] = [];
  const sink: AgentSink = { send: (m) => sent.push(m), say: async (t) => void said.push(t), stopSpeaking() {} };
  const services = mockServices({ latencyMs: 0 });
  services.prefs = prefs;
  const claude = fakeClaude();
  return { agent: createAgent(services, sink, { llm: claude.llm, jev: null, clarify: false }), said, prefs, turns: claude.turns };
}

test("a stated preference is saved, confirmed in one line, and used by the next session's search", async () => {
  const first = session();
  await first.agent.hello("test-user");
  await first.agent.handleText("I always shop at Target");
  await first.agent.handleText("fast shipping matters most to me");
  await first.agent.handleText("Anker is my favorite brand");
  assert.deepEqual(first.said.slice(1), [
    "Got it, I'll remember you prefer Target.",
    "Got it, I'll remember fast shipping matters to you.",
    "Got it, I'll remember you like Anker.",
  ]);
  const profile = await first.prefs.getProfile("test-user");
  assert.equal(profile.ok, true);
  if (!profile.ok) return;
  assert.deepEqual(profile.data.facts.map((f) => [f.kind, f.value]).sort(), [
    ["favorite_brand", "Anker"],
    ["favorite_marketplace", "target"],
    ["priority", "shipping_speed"],
  ]);
  assert.equal(profile.data.facts.find((f) => f.kind === "favorite_marketplace")?.evidence, "I always shop at Target");

  // New session, same store: the search starts from what was saved.
  const next = session(first.prefs);
  await next.agent.hello("test-user");
  await next.agent.handleText("find me a phone charger");
  const need = next.agent.state?.need;
  assert.deepEqual(need?.marketplaces, ["target"]);
  assert.deepEqual(need?.priorities, ["shipping_speed"]);
  assert.ok(need?.niceToHaves.includes("Anker brand"));
  assert.ok(next.said.includes("I'll check Target, your favorite store."));
  assert.match(next.turns[0]!, /<saved_preferences>\nfavorite store: target/);
});

test("a new favorite store replaces the old one, and other users are untouched", async () => {
  const s = session();
  await s.agent.hello("test-user");
  await s.agent.handleText("I always shop at Target");
  await s.agent.handleText("I always shop at Walmart");
  const profile = await s.prefs.getProfile("test-user");
  assert.deepEqual(profile.ok && profile.data.facts.map((f) => f.value), ["walmart"]);
  const other = await s.prefs.getProfile("someone-else");
  assert.deepEqual(other.ok && other.data.facts, []);
});

test("an unknown store is refused, not saved", async () => {
  const s = session();
  await s.agent.hello("test-user");
  await s.agent.handleText("I always shop at Costco");
  const profile = await s.prefs.getProfile("test-user");
  assert.deepEqual(profile.ok && profile.data.facts, []);
});
