import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMsg, Services } from "@visy/contracts";
import { mockServices } from "@visy/contracts/mocks";
import { createAgent, type AgentSink } from "../src/agent.ts";
import {
  applySpeechRate,
  clampSpeechRate,
  parseSpeechRateCommand,
  speechRateConfirm,
} from "../src/speech-rate.ts";

test("parseSpeechRateCommand: absolute, relative, reset", () => {
  assert.deepEqual(parseSpeechRateCommand("set voice speed to 1.5"), { kind: "absolute", rate: 1.5 });
  assert.deepEqual(parseSpeechRateCommand("voice speed 2x"), { kind: "absolute", rate: 2 });
  assert.deepEqual(parseSpeechRateCommand("2x"), { kind: "absolute", rate: 2 });
  assert.deepEqual(parseSpeechRateCommand("speak at 1.2"), { kind: "absolute", rate: 1.2 });
  assert.deepEqual(parseSpeechRateCommand("speak faster"), { kind: "delta", delta: 0.2 });
  assert.deepEqual(parseSpeechRateCommand("talk much slower please"), { kind: "delta", delta: -0.5 });
  assert.deepEqual(parseSpeechRateCommand("slow down"), { kind: "delta", delta: -0.2 });
  assert.deepEqual(parseSpeechRateCommand("speed up a bit"), { kind: "delta", delta: 0.2 });
  assert.deepEqual(parseSpeechRateCommand("normal speed"), { kind: "reset" });
  assert.deepEqual(parseSpeechRateCommand("reset voice speed"), { kind: "reset" });
  assert.deepEqual(parseSpeechRateCommand("change the voice speed"), { kind: "ask" });
  assert.deepEqual(parseSpeechRateCommand("can you change the voice speed"), { kind: "ask" });
  assert.deepEqual(parseSpeechRateCommand("increase the voice speed"), { kind: "delta", delta: 0.2 });
});

test("parseSpeechRateCommand ignores shopping turns", () => {
  assert.equal(parseSpeechRateCommand("faster shipping"), null);
  assert.equal(parseSpeechRateCommand("I need a slow cooker"), null);
  assert.equal(parseSpeechRateCommand("picnic blanket"), null);
  assert.equal(parseSpeechRateCommand("speak about option 2"), null);
});

test("applySpeechRate clamps to 0.6–3", () => {
  assert.equal(clampSpeechRate(0.1), 0.6);
  assert.equal(clampSpeechRate(9), 3);
  assert.equal(applySpeechRate(1, { kind: "delta", delta: 0.2 }), 1.2);
  assert.equal(applySpeechRate(2.9, { kind: "delta", delta: 0.5 }), 3);
  assert.equal(applySpeechRate(1.4, { kind: "reset" }), 1);
});

test("agent: speak faster updates rate, tells the user, and syncs settings.changed", async () => {
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
  // Fixture profile may already set speechRate (1.4); bump from whatever is loaded.
  const before = agent.speechRate;
  await agent.handleText("speak faster");
  const bumped = applySpeechRate(before, { kind: "delta", delta: 0.2 });
  assert.equal(agent.speechRate, bumped);
  assert.equal(said.at(-1), speechRateConfirm(bumped));
  assert.equal(
    sent.some((m) => m.type === "settings.changed" && m.speechRate === bumped),
    true,
  );
  await agent.handleText("set voice speed to 2");
  assert.equal(agent.speechRate, 2);
  assert.equal(agent.state?.phase, "idle");
  assert.equal(agent.state?.shortlist.length ?? 0, 0);
});
