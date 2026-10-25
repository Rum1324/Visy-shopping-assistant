import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMsg, Services } from "@visy/contracts";
import { mockServices } from "@visy/contracts/mocks";
import { createAgent, type AgentSink } from "../src/agent.ts";
import { micMuteConfirm, parseMicMuteCommand } from "../src/mic-mute.ts";

test("parseMicMuteCommand: mute and unmute phrases", () => {
  assert.deepEqual(parseMicMuteCommand("mute"), { muted: true });
  assert.deepEqual(parseMicMuteCommand("mute the mic"), { muted: true });
  assert.deepEqual(parseMicMuteCommand("stop listening"), { muted: true });
  assert.deepEqual(parseMicMuteCommand("turn off the microphone"), { muted: true });
  assert.deepEqual(parseMicMuteCommand("unmute"), { muted: false });
  assert.deepEqual(parseMicMuteCommand("start listening"), { muted: false });
  assert.deepEqual(parseMicMuteCommand("turn the mic on"), { muted: false });
});

test("parseMicMuteCommand ignores shopping turns", () => {
  assert.equal(parseMicMuteCommand("mute colors"), null);
  assert.equal(parseMicMuteCommand("picnic blanket"), null);
  assert.equal(parseMicMuteCommand("add option 2"), null);
});

test("agent: mute confirms and sends settings.changed", async () => {
  const said: string[] = [];
  const sent: ServerMsg[] = [];
  const sink: AgentSink = {
    send: (msg) => sent.push(msg),
    say: async (text) => {
      said.push(text);
    },
    stopSpeaking() {},
  };
  const agent = createAgent(mockServices({ latencyMs: 0 }) as Services, sink, { llm: null });
  await agent.hello("demo-user");
  await agent.handleText("mute");
  assert.equal(said.at(-1), micMuteConfirm(true));
  assert.equal(
    sent.some((m) => m.type === "settings.changed" && m.micMuted === true),
    true,
  );
  await agent.handleText("unmute");
  assert.equal(said.at(-1), micMuteConfirm(false));
  assert.equal(
    sent.some((m) => m.type === "settings.changed" && m.micMuted === false),
    true,
  );
});
