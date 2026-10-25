/**
 * Track A voice gateway + Track B websocket.
 * Mic audio comes in as binary PCM. Cartesia runs here. The extension never sees the key.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { ClientMsg, ServerMsg, type ServerMsg as ServerMsgT } from "@visy/contracts";
import { mockServices } from "@visy/contracts/mocks";
import { createAgent, type SayKind } from "./agent.ts";
import { pageCapture, type CapturePage } from "./navigator/capture.ts";
import { ExtensionDriver } from "./navigator/driver/extension.ts";
import { liveServices } from "./live.ts";
import { convexPreferenceStore } from "./prefs-convex.ts";
import { claudeReviewService } from "./intel/reviews.ts";
import { claudeVisionService } from "./intel/vision.ts";
import { mossReviewIndex } from "./intel/review-index.ts";
import { Cartesia, speechForKind } from "./voice.ts";

const TTS_RATE = 24000;
const STOP_WORDS = /^\s*(stop|wait|cancel|hold on|pause|no)\b/i;
const words = (t: string) => t.toLowerCase().match(/[a-z0-9']+/g) ?? [];
const pairs = (w: string[]) => w.slice(1).map((x, i) => `${w[i]} ${x}`);
/** Which turn (epoch) a piece of agent work belongs to, so a cancelled turn can't speak later. */
const turnScope = new AsyncLocalStorage<number>();

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
  const withPrefs = process.env.PREFS === "convex" ? { ...base, prefs: convexPreferenceStore() } : base;
  // Track D: real review synthesis + vision with NAV=amazon or INTEL=claude. INTEL=mock keeps fixtures.
  const intel = process.env.INTEL ? process.env.INTEL === "claude" : process.env.NAV === "amazon";
  const reviewIndex = intel && process.env.MOSS_PROJECT_ID ? mossReviewIndex() : undefined;
  void reviewIndex?.warm(); // load the embedding model now, not on the first question
  const services = intel
    ? { ...withPrefs, reviews: claudeReviewService(), vision: claudeVisionService(), reviewIndex: reviewIndex ?? withPrefs.reviewIndex }
    : withPrefs;
  const cartesia = opts.disableVoice ? new Cartesia("") : new Cartesia();
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    let sayId = 0;
    let generation = 0;
    let queue: Promise<void> = Promise.resolve();
    /** Jobs queued or speaking — progress TTS is skipped while this is > 0. */
    let ttsBusy = 0;
    const aborters = new Set<AbortController>();
    // A-STT: one live Cartesia turns session while the panel streams the mic (audio.start → audio.end).
    let stt: ReturnType<Cartesia["listen"]> | null = null;
    let sttWarned = false;
    let sttFailures = 0;
    let working = 0; // agent turns in flight
    let speakingUntil = 0; // when the panel finishes playing what we sent
    let spoken: string[] = []; // words Visy is saying now, to tell its echo from the user
    let turn: Promise<void> = Promise.resolve();
    let epoch = 0; // bumped by every interrupt
    const enqueue = (fn: () => Promise<void>) => {
      const mine = epoch;
      // A snapshot after every turn tells the panel the turn is over, so it can play the listen tone.
      const run = () =>
        turnScope.run(mine, async () => {
          if (mine !== epoch) return;
          working++;
          try {
            await fn();
          } finally {
            working--;
            if (mine === epoch && agent.state) send({ type: "session.snapshot", state: agent.state });
          }
        });
      turn = turn.then(run, run);
    };
    /**
     * Barge-in or stop. The agent only checks for cancellation between steps, so a cancelled turn can
     * still be awaiting a page or a model call. Don't make the next turn wait behind it, and drop
     * anything it says once it wakes up.
     */
    function interruptTurn() {
      epoch++;
      turn = Promise.resolve();
      agent.interrupt();
    }

    const driver = new ExtensionDriver(send);
    const capturePage = pageCapture(driver);
    ws.on("close", () => {
      driver.dispose();
      stt?.close();
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
      const scope = turnScope.getStore();
      if (scope !== undefined && scope !== epoch) return Promise.resolve(); // a cancelled turn
      const gen = generation;
      // Progress UI comes from the `progress` wire event. Speak it only when TTS is idle.
      if (kind === "progress") {
        if (ttsBusy > 0 || !cartesia.enabled) return Promise.resolve();
        ttsBusy++;
        const job = queue.then(() => speak(text, kind, gen));
        queue = job.then(
          () => {
            ttsBusy--;
          },
          () => {
            ttsBusy--;
          },
        );
        return job;
      }
      ttsBusy++;
      const job = queue.then(() => speak(text, kind, gen));
      queue = job.then(
        () => {
          ttsBusy--;
        },
        () => {
          ttsBusy--;
        },
      );
      return job;
    }

    async function speak(text: string, kind: SayKind = "answer", gen: number) {
      if (gen !== generation) return;
      const id = `say-${++sayId}`;
      send({ type: "agent.say", id, text, kind });
      await speakAudio(id, text, kind, gen);
    }

    async function speakAudio(id: string, text: string, kind: SayKind, gen: number) {
      if (!cartesia.enabled || gen !== generation) return;
      const { transcript, emotion } = speechForKind(text, kind);
      const ac = new AbortController();
      aborters.add(ac);
      try {
        send({ type: "tts.start", id, format: { encoding: "pcm_s16le", sampleRate: TTS_RATE } });
        const audio = await cartesia.speak(transcript, {
          speed: agent.speechRate,
          emotion,
          signal: ac.signal,
        });
        if (gen !== generation || ws.readyState !== ws.OPEN) return;
        ws.send(audio);
        send({ type: "tts.end", id });
        noteSpoken(transcript, audio.length / 2 / TTS_RATE);
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
      speakingUntil = 0;
      ttsBusy = 0;
      send({ type: "tts.stop" });
    }

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        stt?.send(Buffer.from(raw as Buffer));
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
        interruptTurn();
        return;
      }
      if (msg.type === "audio.start") {
        startHearing(msg.format.sampleRate);
        return;
      }
      if (msg.type === "audio.end") {
        // The panel stopped capture (muted or paused). An unfinished turn is dropped.
        stopHearing();
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

    function stopHearing() {
      stt?.close();
      stt = null;
    }

    function noteSpoken(text: string, seconds: number) {
      const now = Date.now();
      if (speakingUntil < now) spoken = [];
      spoken.push(...words(text));
      speakingUntil = Math.max(now, speakingUntil) + seconds * 1000;
    }

    /**
     * Visy hearing itself through the speakers: the heard words follow what it is saying right now,
     * pair by pair. A user reusing a few of Visy's words ("the first one") doesn't match its phrasing.
     */
    function isEcho(heard: string) {
      if (Date.now() > speakingUntil + 1500) return false;
      const w = words(heard);
      if (w.length < 2) return w.length === 0 || spoken.includes(w[0]!);
      const said = new Set(pairs(spoken));
      return pairs(w).filter((p) => said.has(p)).length / (w.length - 1) >= 0.7;
    }

    /**
     * Hands-free: the panel streams the mic the whole time it is unmuted, Visy's speech included,
     * and Cartesia finds the turns. Real words while Visy talks or works cancel that turn (barge-in),
     * like the OpenAI and Gemini realtime voice modes. Partials go out as `transcript` final:false.
     */
    function startHearing(rate: number) {
      stopHearing();
      if (!cartesia.enabled) {
        if (!sttWarned) void say("Voice needs a Cartesia key on the server. You can type instead.");
        sttWarned = true;
        return;
      }
      let bargedIn = false;
      const session = cartesia.listen(rate, {
        start: () => {
          bargedIn = false;
        },
        update: (text) => {
          if (stt !== session || isEcho(text)) return;
          sttFailures = 0;
          send({ type: "transcript", text, final: false });
          const busy = working > 0 || Date.now() < speakingUntil;
          if (busy && !bargedIn && (words(text).length >= 2 || STOP_WORDS.test(text))) {
            bargedIn = true;
            interruptTurn();
          }
        },
        end: (text) => {
          if (stt !== session || !text || isEcho(text)) return;
          sttFailures = 0;
          send({ type: "transcript", text, final: true });
          enqueue(() => agent.handleText(text));
        },
        error: (e) => {
          if (stt !== session) return;
          stt = null;
          console.warn("stt failed:", e.message);
          // Cartesia drops idle sockets now and then: reconnect quietly a few times before telling the user.
          if (++sttFailures <= 3) {
            setTimeout(() => !stt && ws.readyState === ws.OPEN && startHearing(rate), 400 * sttFailures);
            return;
          }
          send({ type: "error", error: { code: "internal", message: "Speech recognition failed", retryable: true } });
          if (!sttWarned) void say("Speech recognition failed. You can type instead.");
          sttWarned = true;
        },
      });
      stt = session;
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
    const nav = process.env.NAV === "amazon" ? "amazon, target and walmart live" : "fixtures";
    const prefs = process.env.PREFS === "convex" ? "convex" : "fixtures";
    console.log(`visy server on ws://localhost:${port} (cartesia ${voice}, ${nav}, prefs ${prefs})`);
  });
}
