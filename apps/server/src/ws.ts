/**
 * Track A voice gateway + Track B websocket.
 * Mic audio comes in as binary PCM. Cartesia runs here. The extension never sees the key.
 */
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { ClientMsg, ServerMsg, type ServerMsg as ServerMsgT } from "@visy/contracts";
import { mockServices } from "@visy/contracts/mocks";
import { createAgent, type SayKind } from "./agent.ts";
import { pageCapture, type CapturePage } from "./navigator/capture.ts";
import { ExtensionDriver } from "./navigator/driver/extension.ts";
import { liveServices } from "./live.ts";
import { convexPreferenceStore } from "./prefs-convex.ts";
import { Cartesia } from "./voice.ts";

const TTS_RATE = 24000;

/** One per connected client. `capturePage()` returns the user's open tab as a PageState (C5). */
export type Connection = { driver: ExtensionDriver; capturePage: CapturePage };

export function start(
  opts: { port?: number; latencyMs?: number; disableVoice?: boolean; onConnection?: (conn: Connection) => void } = {},
) {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const latencyMs = opts.latencyMs ?? Number(process.env.MOCK_LATENCY_MS ?? 400);
  // NAV=amazon drives the most recently connected extension's Chrome (Playwright when none is connected).
  const extensions: ExtensionDriver[] = [];
  const base = process.env.NAV === "amazon" ? liveServices({ driver: () => extensions.at(-1) }) : mockServices({ latencyMs });
  const services = process.env.PREFS === "convex" ? { ...base, prefs: convexPreferenceStore() } : base;
  const cartesia = opts.disableVoice ? new Cartesia("") : new Cartesia();
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    let sayId = 0;
    let generation = 0;
    let queue: Promise<void> = Promise.resolve();
    const aborters = new Set<AbortController>();
    let capturing = false;
    let sampleRate = 16000;
    let pcm: Buffer[] = [];
    let turn: Promise<void> = Promise.resolve();
    const enqueue = (fn: () => Promise<void>) => {
      turn = turn.then(fn, fn);
    };

    const driver = new ExtensionDriver(send);
    const capturePage = pageCapture(driver);
    ws.on("close", () => {
      driver.dispose();
      const i = extensions.indexOf(driver);
      if (i >= 0) extensions.splice(i, 1);
    });
    opts.onConnection?.({ driver, capturePage });

    const agent = createAgent(services, {
      send,
      say,
      stopSpeaking,
      capturePage,
    });

    function send(msg: ServerMsgT) {
      const parsed = ServerMsg.safeParse(msg);
      if (!parsed.success) {
        console.warn("refusing invalid server message", parsed.error.issues[0]?.message);
        return;
      }
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(parsed.data));
    }

    function say(text: string, kind: SayKind = "answer") {
      const gen = generation;
      const job = queue.then(() => speak(text, kind, gen));
      queue = job.then(
        () => {},
        () => {},
      );
      return job;
    }

    async function speak(text: string, _kind: SayKind, gen: number) {
      if (gen !== generation) return;
      const id = `say-${++sayId}`;
      send({ type: "agent.say", id, text });
      if (!cartesia.enabled || gen !== generation) return;
      const ac = new AbortController();
      aborters.add(ac);
      try {
        send({ type: "tts.start", id, format: { encoding: "pcm_s16le", sampleRate: TTS_RATE } });
        const audio = await cartesia.speak(text, agent.speechRate, ac.signal);
        if (gen !== generation || ws.readyState !== ws.OPEN) return;
        ws.send(audio);
        send({ type: "tts.end", id });
      } catch (e) {
        if (ac.signal.aborted || gen !== generation) return;
        console.warn("tts failed:", e instanceof Error ? e.message : e);
        send({ type: "tts.end", id });
      } finally {
        aborters.delete(ac);
      }
    }

    function stopSpeaking() {
      generation++;
      for (const ac of aborters) ac.abort();
      aborters.clear();
      queue = Promise.resolve();
      send({ type: "tts.stop" });
    }

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        if (capturing) pcm.push(Buffer.from(raw as Buffer));
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        send({ type: "error", error: { code: "parse_failed", message: "Message was not JSON", retryable: false } });
        return;
      }
      const parsed = ClientMsg.safeParse(json);
      if (!parsed.success) {
        send({ type: "error", error: { code: "parse_failed", message: parsed.error.message, retryable: false } });
        return;
      }
      const msg = parsed.data;
      if (msg.type === "hello") {
        if (msg.client === "extension" && !extensions.includes(driver)) extensions.push(driver);
        enqueue(() => agent.hello(msg.userId, msg.displayName));
        return;
      }
      if (msg.type === "user.text") {
        enqueue(() => agent.handleText(msg.text));
        return;
      }
      if (msg.type === "user.interrupt") {
        capturing = false;
        pcm = [];
        agent.interrupt();
        return;
      }
      if (msg.type === "audio.start") {
        capturing = true;
        pcm = [];
        sampleRate = msg.format.sampleRate;
        return;
      }
      if (msg.type === "audio.end") {
        capturing = false;
        const audio = Buffer.concat(pcm);
        pcm = [];
        enqueue(() => hear(audio, sampleRate));
        return;
      }
      if (msg.type === "settings.update") {
        agent.setSpeech({ speechRate: msg.speechRate });
        return;
      }
      if (msg.type === "checkout.confirm") {
        enqueue(() => agent.confirm(msg.total));
        return;
      }
      if (msg.type === "driver.response") {
        driver.handle(msg);
      }
    });

    async function hear(audio: Buffer, rate: number) {
      if (!cartesia.enabled) {
        await say("Voice needs a Cartesia key on the server. You can type instead.");
        return;
      }
      try {
        const text = await cartesia.transcribe(audio, rate);
        if (!text) {
          await say("I didn't catch that. Try again, or type it.");
          return;
        }
        await agent.handleText(text);
      } catch (e) {
        console.warn("stt failed:", e instanceof Error ? e.message : e);
        send({
          type: "error",
          error: { code: "internal", message: "Speech recognition failed", retryable: true },
        });
        await say("Speech recognition failed. Try again, or type it.");
      }
    }
  });

  return wss;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("unhandledRejection", (reason) => {
    console.warn("unhandledRejection", reason instanceof Error ? reason.message : reason);
  });
  const wss = start();
  wss.on("listening", () => {
    const addr = wss.address();
    const port = typeof addr === "object" && addr ? addr.port : "?";
    const voice = process.env.CARTESIA_API_KEY?.trim() ? "on" : "off";
    const nav = process.env.NAV === "amazon" ? "amazon live, target and walmart fixtures" : "fixtures";
    const prefs = process.env.PREFS === "convex" ? "convex" : "fixtures";
    console.log(`visy server on ws://localhost:${port} (cartesia ${voice}, ${nav}, prefs ${prefs})`);
  });
}
