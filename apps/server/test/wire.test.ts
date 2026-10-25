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
  ws.send(JSON.stringify({ type: "user.text", text: "no preference" }));
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
