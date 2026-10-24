import { appendFileSync, mkdirSync } from "node:fs";
import { err, ok, type ElementPicker, type PageState, type PickResult, type Result } from "@visy/contracts";
import { type FindStep } from "./pickers/common.ts";
import { MemoryPicker } from "./pickers/memory.ts";
import { MossPicker, mossClient } from "./pickers/moss.ts";
import { ClaudePicker } from "./pickers/claude.ts";

/** PICKER_CHAIN="memory,moss,claude" (default). "claude" alone is the slow baseline for the speed comparison. */
export function buildChain(spec = process.env.PICKER_CHAIN ?? "memory,moss,claude") {
  const names = spec.split(",").map((s) => s.trim());
  const needsMoss = names.includes("memory") || names.includes("moss");
  const client = needsMoss ? mossClient() : undefined;
  const memory = names.includes("memory") ? new MemoryPicker(client) : undefined;
  const moss = names.includes("moss") ? new MossPicker(client) : undefined;
  const claude = names.includes("claude") ? new ClaudePicker() : undefined;
  const byName = { memory, moss, claude } as Record<string, ElementPicker | undefined>;
  const pickers = names.map((n) => byName[n]).filter((p): p is ElementPicker => !!p);
  return {
    pickers,
    memory,
    moss,
    claude,
    close: async () => {
      await moss?.close();
      await memory?.close();
    },
  };
}

export type ChainPick = PickResult & { trusted: boolean; tried: string[] };

mkdirSync("logs", { recursive: true });
const log = (row: object) => appendFileSync("logs/picks.jsonl", JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n");

/**
 * Runs pickers in order and returns the first trusted pick. Order comes from PICKER_CHAIN (e.g. "memory,moss,claude").
 * A trusted pick from a slow picker (moss/claude) is written back to memory so next time it's a ~5 ms lookup.
 * Purchase-risk elements are rejected here too, whatever a picker returns.
 */
export async function pickWithChain(
  pickers: ElementPicker[],
  state: PageState,
  step: FindStep,
  memory?: MemoryPicker,
): Promise<Result<ChainPick>> {
  const tried: string[] = [];
  for (const p of pickers) {
    tried.push(p.name);
    const r = await p.pick(state, step);
    log({ url: state.url, intent: step.intent, ...(r.ok ? r.data : { picker: p.name, error: r.error.code }) });
    if (!r.ok || !r.data.trusted) continue;
    const el = state.elements.find((e) => e.idx === r.data.idx);
    if (!el || el.purchaseRisk) continue;
    if (memory && p.name !== "recipe") await memory.remember(state, step, el).catch(() => {});
    return ok({ ...r.data, tried });
  }
  return err("low_confidence", `no trusted pick for "${step.intent}" (tried ${tried.join(" → ")})`);
}
