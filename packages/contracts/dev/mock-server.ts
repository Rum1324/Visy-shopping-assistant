/**
 * Fake Visy server that speaks the real wire protocol using fixtures.
 * The extension/voice track builds against this before the real server exists.
 *
 *   npm run mock-server        (ws://localhost:8787)
 *
 * Send {"type":"user.text","text":"picnic blanket"} (or audio.start…audio.end) to play the demo script.
 * Send {"type":"user.text","text":"driver test"} to get driver.requests for your content-script driver.
 * There is no TTS audio here. Test Cartesia directly. agent.say text is sent so captions can be built.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { ClientMsg, CONTRACT_VERSION, ServerMsg, type SessionState } from "../src/index.ts";
import { fixtures } from "../src/fixtures.ts";

const PORT = Number(process.env.PORT ?? 8787);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

const wss = new WebSocketServer({ port: PORT });
console.log(`mock server on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  let sayId = 0;
  let script: AbortController | null = null;

  const send = (msg: ServerMsg) => {
    ServerMsg.parse(msg); // the mock never sends invalid messages
    ws.send(JSON.stringify(msg));
  };
  const say = (text: string) => send({ type: "agent.say", id: `say-${++sayId}`, text });
  const snapshot = (patch: Partial<SessionState>) =>
    send({ type: "session.snapshot", state: { ...fixtures.session, ...patch, updatedAt: now() } });

  async function demo(signal: AbortSignal) {
    const step = async (ms: number) => {
      await sleep(ms);
      if (signal.aborted) throw new Error("interrupted");
    };
    snapshot({ phase: "clarifying", candidates: [], shortlist: [] });
    say("A picnic blanket, got it. How many people should it fit, and do you need it waterproof?");
    await step(1500);
    say("Anything else you want me to keep in mind?");
    await step(1500);
    snapshot({ phase: "searching", candidates: [], shortlist: [] });
    for (const m of fixtures.need.marketplaces) {
      send({ type: "progress", event: { stage: "searching", marketplace: m, message: `Searching ${m} now`, at: now() } });
      await step(900);
    }
    snapshot({ phase: "shortlisting", shortlist: [] });
    send({ type: "progress", event: { stage: "reviews", message: "Comparing reviews", at: now() } });
    for (let i = 1; i <= 3; i++) {
      await step(1200);
      snapshot({ phase: i === 3 ? "presenting" : "shortlisting", shortlist: fixtures.shortlist.slice(0, i) });
      const item = fixtures.shortlist[i - 1]!;
      say(`Option ${i}: ${item.product.title}, $${(item.product.price.cents / 100).toFixed(2)}. ${item.visual?.short ?? ""} ${item.reviews?.summary ?? ""}`);
    }
  }

  async function driverTest() {
    const reqs: ServerMsg[] = [
      { type: "driver.request", id: "d1", req: { op: "openTab", url: "https://www.amazon.com/s?k=picnic+blanket" } },
      { type: "driver.request", id: "d2", req: { op: "snapshot", tabId: -1 } },
    ];
    for (const r of reqs) {
      send(r);
      await sleep(1500);
    }
  }

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return; // mic audio: ignored by the mock
    const parsed = ClientMsg.safeParse(JSON.parse(raw.toString()));
    if (!parsed.success) {
      console.warn("invalid client message:", parsed.error.issues);
      send({ type: "error", error: { code: "parse_failed", message: parsed.error.message, retryable: false } });
      return;
    }
    const msg = parsed.data;
    console.log("←", msg.type);
    switch (msg.type) {
      case "hello":
        send({ type: "welcome", sessionId: `mock-${Date.now()}`, protocol: CONTRACT_VERSION });
        snapshot({ phase: "idle", candidates: [], shortlist: [] });
        break;
      case "user.text":
      case "audio.end": {
        const text = msg.type === "user.text" ? msg.text : "picnic blanket";
        send({ type: "transcript", text, final: true });
        if (text.includes("driver test")) void driverTest();
        else {
          script?.abort();
          script = new AbortController();
          demo(script.signal).catch(() => {});
        }
        break;
      }
      case "user.interrupt":
        script?.abort();
        send({ type: "tts.stop" });
        break;
      case "driver.response":
        console.log("  driver.response", msg.id, msg.ok, msg.ok ? "" : msg.error);
        break;
      case "checkout.confirm":
        say("Thanks. I won't place the order myself. Press Place your order when you're ready.");
        break;
    }
  });
});
