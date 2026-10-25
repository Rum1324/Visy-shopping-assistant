import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { ServerMsg } from "@visy/contracts";
import { start } from "../src/ws.ts";

test("websocket picnic blanket, questions answered, reaches presenting without checkout", async () => {
  const wss = start({ port: 0, latencyMs: 0, disableVoice: true });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: ServerMsg[] = [];
  await new Promise<void>((resolve) => ws.once("open", () => resolve()));
  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString()) as ServerMsg;
    msgs.push(parsed);
  });
  ws.send(JSON.stringify({ type: "hello", protocol: 1, userId: "demo-user", client: "cli" }));
  ws.send(JSON.stringify({ type: "user.text", text: "picnic blanket" }));
  // The agent asks its questions first; answer them.
  const asked = Date.now() + 5000;
  while (Date.now() < asked && !msgs.some((m) => m.type === "session.snapshot" && m.state.phase === "clarifying")) {
    await new Promise((r) => setTimeout(r, 20));
  }
  ws.send(JSON.stringify({ type: "user.text", text: "just search" }));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const snap = msgs.find((m) => m.type === "session.snapshot" && m.state.phase === "presenting");
    if (snap && snap.type === "session.snapshot" && snap.state.shortlist.length === 3) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  ws.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  const presenting = msgs.find((m) => m.type === "session.snapshot" && m.state.phase === "presenting");
  assert.ok(presenting && presenting.type === "session.snapshot");
  assert.equal(presenting.state.shortlist.length, 3);
  assert.equal(msgs.some((m) => m.type === "checkout.confirmRequired"), false);
});

test("websocket: a question that cuts off the picks keeps them and does not search or ask again", async () => {
  // Live run: barge-in right after the names and prices left an empty shortlist, so Visy asked for a budget and searched again.
  const wss = start({ port: 0, latencyMs: 60, disableVoice: true });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: ServerMsg[] = [];
  await new Promise<void>((resolve) => ws.once("open", () => resolve()));
  let cutAt = -1;
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as ServerMsg;
    msgs.push(msg);
    if (cutAt < 0 && msg.type === "agent.say" && /^(Best match|Option 1): /.test(msg.text)) {
      cutAt = msgs.length;
      ws.send(JSON.stringify({ type: "user.interrupt" }));
      ws.send(JSON.stringify({ type: "user.text", text: "is the last one really that cheap?" }));
    }
  });
  const until = async (ok: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !ok()) await new Promise((r) => setTimeout(r, 20));
  };
  ws.send(JSON.stringify({ type: "hello", protocol: 1, userId: "demo-user", client: "cli" }));
  ws.send(JSON.stringify({ type: "user.text", text: "picnic blanket" }));
  await until(() => msgs.some((m) => m.type === "session.snapshot" && m.state.phase === "clarifying"));
  ws.send(JSON.stringify({ type: "user.text", text: "just search" }));
  await until(() => cutAt >= 0);
  // The answer to the cut-in question, then let the cancelled search's details land.
  await until(() => msgs.slice(cutAt).some((m) => m.type === "agent.say"));
  await new Promise((r) => setTimeout(r, 400));
  ws.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));

  assert.ok(cutAt >= 0, "never read the picks");
  const after = msgs.slice(cutAt);
  const says = after.flatMap((m) => (m.type === "agent.say" ? [m.text] : []));
  assert.ok(says.length, "no answer");
  assert.ok(!says.some((s) => /^I'll check|budget|^Sure,/i.test(s)), says.join(" | "));
  assert.ok(!after.some((m) => m.type === "session.snapshot" && ["clarifying", "searching"].includes(m.state.phase)));
  const snaps = after.flatMap((m) => (m.type === "session.snapshot" ? [m.state] : []));
  assert.equal(snaps.at(-1)?.shortlist.length, 3);
  assert.ok(snaps.at(-1)?.shortlist.some((i) => i.visual), "details never landed after the cut-in");
});
