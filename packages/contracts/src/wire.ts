import { z } from "zod";
import { AppError, Money, ProgressEvent } from "./common.ts";
import { DriverRequest } from "./driver.ts";
import { CheckoutReview, SessionState } from "./session.ts";

/**
 * WebSocket protocol between a client (the extension's side panel) and the server.
 * Text frames are JSON matching these schemas. Binary frames are raw audio:
 *   client → server: mic audio, PCM s16le mono, sent between audio.start and audio.end
 *   server → client: TTS audio for the current tts.start id, in the format it announced
 */

export const AudioFormat = z.object({
  encoding: z.literal("pcm_s16le"),
  sampleRate: z.number().int(), // 16000 for mic, 24000 or 44100 for TTS
});

export const ClientMsg = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.number().int(),
    userId: z.string(),
    client: z.enum(["extension", "web", "cli"]),
    displayName: z.string().optional(),
  }),
  z.object({ type: z.literal("audio.start"), format: AudioFormat }),
  z.object({ type: z.literal("audio.end") }),
  /** Typed input. Also how the server track tests without the voice stack. */
  z.object({ type: z.literal("user.text"), text: z.string() }),
  /** Barge-in: the user started talking or pressed stop. The server must stop TTS right away. */
  z.object({ type: z.literal("user.interrupt") }),
  z.object({
    type: z.literal("settings.update"),
    speechRate: z.number().min(0.5).max(3).optional(),
    verbosity: z.enum(["brief", "normal", "detailed"]).optional(),
  }),
  z.object({
    type: z.literal("driver.response"),
    id: z.string(),
    ok: z.boolean(),
    data: z.unknown().optional(), // validate with DriverResponseData[op]
    error: AppError.optional(),
  }),
  /** The user explicitly confirmed the order total that was read back. */
  z.object({ type: z.literal("checkout.confirm"), total: Money }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

export const ServerMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), sessionId: z.string(), protocol: z.number().int() }),
  z.object({ type: z.literal("transcript"), text: z.string(), final: z.boolean() }),
  /** Text being spoken, for captions and braille displays. Sent before the matching audio. */
  z.object({
    type: z.literal("agent.say"),
    id: z.string(),
    text: z.string(),
    /** progress = in-place thinking line in the chat; omit/answer = new turn. */
    kind: z.enum(["answer", "progress", "question"]).optional(),
  }),
  z.object({ type: z.literal("tts.start"), id: z.string(), format: AudioFormat }),
  z.object({ type: z.literal("tts.end"), id: z.string() }),
  /** Drop any buffered TTS audio right now (barge-in). */
  z.object({ type: z.literal("tts.stop") }),
  z.object({ type: z.literal("progress"), event: ProgressEvent }),
  z.object({ type: z.literal("session.snapshot"), state: SessionState }),
  z.object({ type: z.literal("driver.request"), id: z.string(), req: DriverRequest }),
  z.object({ type: z.literal("checkout.confirmRequired"), review: CheckoutReview }),
  /** Server applied a settings change (voice/text). Client should update UI / localStorage / mic. */
  z.object({
    type: z.literal("settings.changed"),
    speechRate: z.number().min(0.5).max(3).optional(),
    verbosity: z.enum(["brief", "normal", "detailed"]).optional(),
    /** True = mute mic (same as the side-panel mic button). */
    micMuted: z.boolean().optional(),
  }),
  z.object({ type: z.literal("error"), error: AppError }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;
