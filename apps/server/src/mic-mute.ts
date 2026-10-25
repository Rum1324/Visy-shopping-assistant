/**
 * Voice / text commands that mute or unmute the mic (same control as the side-panel mic button).
 * Matched before Claude so "mute" never becomes a product search.
 */

export type MicMuteCommand = { muted: boolean };

/**
 * Returns a mute/unmute command when the utterance is about Visy's microphone.
 * Leaves shopping alone ("mute colors", "unmute this listing", …).
 */
export function parseMicMuteCommand(text: string): MicMuteCommand | null {
  const said = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!said) return null;

  // Unmute first so "unmute" isn't caught by a bare "mute" substring check wrongly —
  // we use word boundaries either way.
  const unmute =
    /^(?:please\s+)?(?:can\s+you\s+)?(?:unmute|un-mute)(?:\s+(?:the\s+)?(?:mic|microphone|yourself))?(?:\s+please)?$/.test(said) ||
    /^(?:please\s+)?(?:can\s+you\s+)?(?:turn|switch)\s+(?:the\s+)?(?:mic|microphone)\s+on(?:\s+please)?$/.test(said) ||
    /^(?:please\s+)?(?:can\s+you\s+)?(?:start|resume)\s+listening(?:\s+please)?$/.test(said) ||
    /^(?:please\s+)?(?:listen|listening)\s+again(?:\s+please)?$/.test(said) ||
    /^(?:please\s+)?(?:turn|switch)\s+on\s+(?:the\s+)?(?:mic|microphone)(?:\s+please)?$/.test(said);
  if (unmute) return { muted: false };

  const mute =
    /^(?:please\s+)?(?:can\s+you\s+)?(?:mute|quiet)(?:\s+(?:the\s+)?(?:mic|microphone|yourself))?(?:\s+please)?$/.test(said) ||
    /^(?:please\s+)?(?:can\s+you\s+)?(?:turn|switch)\s+(?:the\s+)?(?:mic|microphone)\s+off(?:\s+please)?$/.test(said) ||
    /^(?:please\s+)?(?:can\s+you\s+)?(?:stop|pause)\s+listening(?:\s+please)?$/.test(said) ||
    /^(?:please\s+)?(?:turn|switch)\s+off\s+(?:the\s+)?(?:mic|microphone)(?:\s+please)?$/.test(said) ||
    /^(?:please\s+)?(?:don't|do not|stop)\s+listen(?:ing)?(?:\s+please)?$/.test(said);
  if (mute) return { muted: true };

  return null;
}

export function micMuteConfirm(muted: boolean): string {
  return muted
    ? "Okay, muted. Type unmute or press Control M when you want me to listen again."
    : "Okay, listening again.";
}
