/**
 * Cartesia TTS and STT. The API key stays in the server process.
 * Never log it, and never send it to the extension.
 */
import WebSocket from "ws";

const CARTESIA_VERSION = "2026-08-14";
const DEFAULT_VOICE = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";

/** Primary Cartesia emotions we use for say-kind tone. */
export type CartesiaEmotion = "calm" | "curious" | "confident" | "neutral" | "content";

export type SpeakOpts = {
  speed?: number;
  /** Guides Sonic emotion; omit to let the model read the transcript. */
  emotion?: CartesiaEmotion;
  signal?: AbortSignal;
};

/**
 * Shape transcript + emotion so progress updates sound declarative, not like a question.
 * Trailing ellipses make Sonic rise; strip them and end with a period. Calm emotion seals it.
 */
export function speechForKind(
  text: string,
  kind: "answer" | "progress" | "question" = "answer",
): { transcript: string; emotion?: CartesiaEmotion } {
  const raw = text.trim();
  if (kind === "progress") {
    const body = raw.replace(/[.…]+$/u, "").trimEnd();
    return { transcript: body ? `${body}.` : raw, emotion: "calm" };
  }
  if (kind === "question") return { transcript: raw, emotion: "curious" };
  return { transcript: raw };
}

export class Cartesia {
  constructor(
    private apiKey = process.env.CARTESIA_API_KEY?.trim() ?? "",
    private voiceId = process.env.CARTESIA_VOICE_ID?.trim() || DEFAULT_VOICE,
  ) {}

  get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  async speak(text: string, opts: SpeakOpts | number = {}, signal?: AbortSignal): Promise<Buffer> {
    if (!this.enabled) throw new Error("CARTESIA_API_KEY is not set");
    // Back-compat: speak(text, speed, signal)
    const normalized: SpeakOpts =
      typeof opts === "number" ? { speed: opts, signal } : { ...opts, signal: opts.signal ?? signal };
    const generation_config: { speed: number; emotion?: CartesiaEmotion } = {
      speed: clamp(normalized.speed ?? 1, 0.6, 1.5),
    };
    if (normalized.emotion) generation_config.emotion = normalized.emotion;

    const res = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      signal: normalized.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "X-API-Key": this.apiKey,
        "Cartesia-Version": CARTESIA_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: process.env.CARTESIA_TTS_MODEL?.trim() || "sonic-3.6",
        transcript: text,
        voice: this.voiceId,
        language: "en",
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
        generation_config,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 180);
      throw new Error(`Cartesia TTS failed (${res.status}): ${detail}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** pcm is raw s16le mono. Resolves to the final transcript. */
  transcribe(pcm: Buffer, sampleRate: number, signal?: AbortSignal): Promise<string> {
    if (!this.enabled) return Promise.reject(new Error("CARTESIA_API_KEY is not set"));
    if (pcm.length < 2) return Promise.resolve("");

    const url = new URL("wss://api.cartesia.ai/stt/websocket");
    url.searchParams.set("model", process.env.CARTESIA_STT_MODEL?.trim() || "ink-2");
    url.searchParams.set("encoding", "pcm_s16le");
    url.searchParams.set("sample_rate", String(sampleRate));
    url.searchParams.set("cartesia_version", CARTESIA_VERSION);
    url.searchParams.set("language", "en");

    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "X-API-Key": this.apiKey,
      },
    });

    return new Promise((resolve, reject) => {
      const finals: string[] = [];
      let settled = false;
      const finish = (err?: Error, text?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.close();
        if (err) reject(err);
        else resolve((text ?? "").trim());
      };
      const onAbort = () => finish(new Error("aborted"));
      const timer = setTimeout(() => finish(new Error("Cartesia STT timed out")), 12_000);
      signal?.addEventListener("abort", onAbort);

      socket.on("open", () => {
        const chunk = Math.max(2, Math.floor(sampleRate * 0.1) * 2);
        for (let i = 0; i < pcm.length; i += chunk) socket.send(pcm.subarray(i, i + chunk));
        socket.send("finalize");
      });

      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        let msg: { type?: string; is_final?: boolean; text?: string; message?: string };
        try {
          msg = JSON.parse(data.toString()) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === "transcript" && msg.is_final && msg.text) finals.push(msg.text);
        if (msg.type === "flush_done") finish(undefined, finals.join(""));
        if (msg.type === "error") finish(new Error(msg.message || "Cartesia STT error"));
      });

      socket.on("error", (err) => finish(err instanceof Error ? err : new Error("Cartesia STT socket error")));
      socket.on("close", () => {
        if (!settled && finals.length) finish(undefined, finals.join(""));
      });
    });
  }

  /**
   * Live STT with Cartesia's own turn detection (/stt/turns/websocket, "Realtime STT (Auto)",
   * which their docs recommend for voice agents). Stream raw s16le mono with send(); `update`
   * gets the cumulative transcript of the current turn, `end` the final one. Audio sent before
   * the socket opens is buffered.
   */
  listen(
    sampleRate: number,
    on: { start?: () => void; update: (text: string) => void; end: (text: string) => void; error: (err: Error) => void },
  ): { send: (pcm: Buffer) => void; close: () => void } {
    const url = new URL("wss://api.cartesia.ai/stt/turns/websocket");
    url.searchParams.set("model", process.env.CARTESIA_STT_MODEL?.trim() || "ink-2");
    url.searchParams.set("encoding", "pcm_s16le");
    url.searchParams.set("sample_rate", String(sampleRate));
    url.searchParams.set("cartesia_version", CARTESIA_VERSION);
    url.searchParams.append("keyterm", "Visy"); // otherwise heard as "Vizzy"
    // Tuning knobs from the API reference; unset keeps Cartesia's defaults.
    for (const [param, env] of [
      ["turn_end_threshold", "CARTESIA_TURN_END_THRESHOLD"],
      ["turn_end_timeout_ms", "CARTESIA_TURN_END_TIMEOUT_MS"],
    ] as const) {
      const v = process.env[env]?.trim();
      if (v) url.searchParams.set(param, v);
    }
    const socket = new WebSocket(url, { headers: { "X-API-Key": this.apiKey } });
    let pending: Buffer[] = [];
    let closed = false;
    socket.on("open", () => {
      for (const b of pending) socket.send(b);
      pending = [];
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary || closed) return;
      let msg: { type?: string; transcript?: string; message?: string };
      try {
        msg = JSON.parse(data.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "turn.start") on.start?.();
      else if ((msg.type === "turn.update" || msg.type === "turn.eager_end") && msg.transcript) on.update(msg.transcript);
      else if (msg.type === "turn.end") on.end((msg.transcript ?? "").trim());
      else if (msg.type === "error") on.error(new Error(msg.message || "Cartesia STT error"));
    });
    socket.on("unexpected-response", (_req, res) => {
      if (!closed) on.error(new Error(`Cartesia STT refused (${res.statusCode})`));
      socket.terminate();
    });
    socket.on("error", (err) => {
      if (!closed) on.error(err instanceof Error ? err : new Error("Cartesia STT socket error"));
    });
    socket.on("close", (code) => {
      if (!closed) on.error(new Error(`Cartesia STT closed (${code})`));
    });
    return {
      send(pcm) {
        if (closed) return;
        if (socket.readyState === WebSocket.OPEN) socket.send(pcm);
        else if (socket.readyState === WebSocket.CONNECTING) pending.push(pcm);
      },
      close() {
        if (closed) return;
        closed = true;
        pending = [];
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close();
      },
    };
  }
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return 1;
  return Math.min(max, Math.max(min, n));
}
