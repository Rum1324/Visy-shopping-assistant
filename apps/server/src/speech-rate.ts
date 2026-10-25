/**
 * Voice / text commands that change TTS speed without opening Settings.
 * Matched before Claude routing so "speak faster" never becomes a product search.
 */

export const SPEECH_RATE_MIN = 0.6;
export const SPEECH_RATE_MAX = 3;

export type SpeechRateCommand =
  | { kind: "absolute"; rate: number }
  | { kind: "delta"; delta: number }
  | { kind: "reset" }
  /** They asked to change speed but didn't say how — ask faster/slower/a number. */
  | { kind: "ask" };

const STEP = 0.2;
const BIG = 0.5;

/** Round to one decimal and clamp to the side-panel / Cartesia-extra range. */
export function clampSpeechRate(n: number): number {
  const stepped = Math.round(n * 10) / 10;
  return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, stepped));
}

export function applySpeechRate(current: number, cmd: Exclude<SpeechRateCommand, { kind: "ask" }>): number {
  if (cmd.kind === "reset") return 1;
  if (cmd.kind === "absolute") return clampSpeechRate(cmd.rate);
  return clampSpeechRate(current + cmd.delta);
}

/** True when the utterance is about Visy's speaking speed, not shipping/cookers/etc. */
function aboutVoiceSpeed(said: string): boolean {
  if (/\b(shipping|delivery|cooker|processor|charge)\b/.test(said)) return false;
  return (
    /\b(voice|speech|speaking)\s+(speed|rate)\b/.test(said) ||
    /\b(speed|rate)\s+of\s+(your\s+|the\s+|my\s+)?(voice|speech)\b/.test(said) ||
    /\bhow\s+fast\s+you\s+(speak|talk)\b/.test(said) ||
    /\b(speak|talk)(?:ing)?\s+(?:speed|rate|pace)\b/.test(said)
  );
}

/**
 * Returns a command when the utterance is about voice speed.
 * Leaves shopping turns alone ("faster shipping", "slow cooker", …).
 */
export function parseSpeechRateCommand(text: string): SpeechRateCommand | null {
  const said = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!said) return null;

  const absolute =
    said.match(/\b(?:voice|speech|speaking)?\s*(?:speed|rate)\s*(?:to|at|=|:)?\s*([\d.]+)\s*x?\b/) ??
    said.match(/\b(?:speak|talk)\s+(?:at|at\s+a\s+speed\s+of)\s*([\d.]+)\s*x?\b/) ??
    said.match(/\b([\d.]+)\s*x(?:\s+(?:voice|speech))?(?:\s+(?:speed|rate))?\b/);
  if (absolute?.[1] && (aboutVoiceSpeed(said) || /^(?:please\s+)?[\d.]+x$/.test(said) || /^(?:please\s+)?(?:speak|talk)\s+at/.test(said))) {
    const rate = Number(absolute[1]);
    if (Number.isFinite(rate)) return { kind: "absolute", rate };
  }

  if (
    /\b(?:normal|default|reset)\s+(?:voice\s+|speech\s+)?(?:speed|rate)\b/.test(said) ||
    /\b(?:voice|speech)\s+(?:speed|rate)\s+(?:to\s+)?(?:normal|default|reset)\b/.test(said) ||
    /\b(?:speak|talk)\s+(?:at\s+)?(?:normal|default)\s+(?:speed|rate)\b/.test(said) ||
    /\breset\s+(?:the\s+)?(?:voice|speech)\s+(?:speed|rate)\b/.test(said)
  ) {
    return { kind: "reset" };
  }

  const faster =
    /\b(?:speak|talk)\s+(?:a\s+(?:bit|little)\s+)?(?:much\s+)?faster\b/.test(said) ||
    /\b(?:speed\s+up|go\s+faster)\b/.test(said) ||
    /\b(?:voice|speech)\s+(?:a\s+(?:bit|little)\s+)?(?:much\s+)?faster\b/.test(said) ||
    /\b(?:make\s+(?:it|the\s+voice|your\s+voice|speech)\s+)(?:a\s+(?:bit|little)\s+)?(?:much\s+)?faster\b/.test(said) ||
    /\b(?:increase|raise|bump\s+up)\s+(?:the\s+)?(?:voice|speech)?\s*(?:speed|rate)\b/.test(said) ||
    (aboutVoiceSpeed(said) && /\b(faster|increase|quicker|speed\s+up)\b/.test(said));
  if (faster && !/\b(shipping|delivery)\b/.test(said)) {
    const delta = /\bmuch\b|\ba\s+lot\b/.test(said) ? BIG : STEP;
    return { kind: "delta", delta };
  }

  const slower =
    /\b(?:speak|talk)\s+(?:a\s+(?:bit|little)\s+)?(?:much\s+)?slower\b/.test(said) ||
    /\b(?:slow\s+down|go\s+slower)\b/.test(said) ||
    /\b(?:voice|speech)\s+(?:a\s+(?:bit|little)\s+)?(?:much\s+)?slower\b/.test(said) ||
    /\b(?:make\s+(?:it|the\s+voice|your\s+voice|speech)\s+)(?:a\s+(?:bit|little)\s+)?(?:much\s+)?slower\b/.test(said) ||
    /\b(?:decrease|lower|reduce)\s+(?:the\s+)?(?:voice|speech)?\s*(?:speed|rate)\b/.test(said) ||
    (aboutVoiceSpeed(said) && /\b(slower|decrease|slow\s+down)\b/.test(said));
  if (slower) {
    const delta = /\bmuch\b|\ba\s+lot\b/.test(said) ? -BIG : -STEP;
    return { kind: "delta", delta };
  }

  // "change the voice speed" / "can you adjust speech rate" with no direction
  if (
    aboutVoiceSpeed(said) &&
    /\b(change|adjust|set|update|modify|control|turn\s+(?:up|down)|alter)\b/.test(said)
  ) {
    return { kind: "ask" };
  }
  if (/^(?:please\s+)?(?:can\s+you\s+)?(?:change|adjust)\s+(?:the\s+|your\s+|my\s+)?(?:voice|speech)\s+(?:speed|rate)(?:\s+please)?$/.test(said)) {
    return { kind: "ask" };
  }

  return null;
}

export function speechRateConfirm(rate: number): string {
  return `Okay, voice speed is ${rate.toFixed(1)} times.`;
}

export function speechRateAsk(current: number): string {
  return `Voice speed is ${current.toFixed(1)} times. Say faster, slower, or a number like 1.5.`;
}
