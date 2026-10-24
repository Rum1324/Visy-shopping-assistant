import Anthropic from "@anthropic-ai/sdk";
import { err, type Result } from "@visy/contracts";

/** Model for D's synthesis and vision. INTEL_MODEL / INTEL_EFFORT override (e.g. claude-haiku-5-5 for speed). */
export const INTEL_MODEL = process.env.INTEL_MODEL || "claude-opus-5-5";
export const INTEL_EFFORT = (process.env.INTEL_EFFORT || "low") as "low" | "medium" | "high";

// Same pinning as the Claude picker: ANTHROPIC_BASE_URL may point elsewhere in the host shell.
export const intelClient = () => new Anthropic({ baseURL: process.env.VISY_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com" });

export function claudeErr<T>(e: unknown, what: string): Result<T> {
  if (e instanceof Anthropic.RateLimitError) return err("rate_limited", e.message, true);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return err("timeout", `${what}: ${e.message}`, true);
  if (e instanceof Anthropic.APIError) return err("internal", `${what} ${e.status}: ${e.message}`, true);
  return err("internal", `${what}: ${(e as Error).message}`, true);
}
