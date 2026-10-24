/**
 * Offline picker bake-off (ARCHITECTURE §4a) on saved snapshots. Nothing hits the retailers.
 *   npm run bench -w @visy/server                       # moss α sweep + default Claude sweep
 *   npm run bench -w @visy/server -- --no-claude        # moss only (free, fast)
 *   npm run bench -w @visy/server -- --claude=claude-haiku-5-5:low:off,claude-opus-5-5:low:on
 * Prints accuracy / latency per picker config, sweeps MOSS_GAP, and simulates moss→claude chains.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PageElement, PageState } from "@visy/contracts";
import { MossPicker } from "../src/navigator/pickers/moss.ts";
import { ClaudePicker, parseClaudeConfig } from "../src/navigator/pickers/claude.ts";
import type { FindStep } from "../src/navigator/pickers/common.ts";

type Task = { pageType: string; intent: string; then: FindStep["then"]; expect: { roles: string[]; name: string; section?: string } };
type Row = { picker: string; snap: string; intent: string; correct: boolean; trusted: boolean; gap: number; latencyMs: number; indexMs: number; error?: string };

const DEFAULT_CLAUDE = ["claude-opus-5-5:low:on", "claude-sonnet-5-5:low:on", "claude-sonnet-5-5:low:off", "claude-haiku-5-5:low:on", "claude-haiku-5-5:low:off"];
const ALPHAS = [0.8, 0.5, 0.2, 0];

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const claudeSpecs = process.argv.includes("--no-claude") ? [] : (arg("claude")?.split(",") ?? DEFAULT_CLAUDE);

const tasks: Task[] = JSON.parse(readFileSync("bench/tasks.json", "utf8"));
const snaps = readdirSync("bench/snapshots")
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, ...(JSON.parse(readFileSync(`bench/snapshots/${f}`, "utf8")) as { pageType: string; state: PageState }) }));
if (!snaps.length) throw new Error("no snapshots: run `npm run snap -w @visy/server` first");

const matches = (e: PageElement, x: Task["expect"]) =>
  !e.purchaseRisk &&
  x.roles.includes(e.role) &&
  new RegExp(x.name, "i").test(e.name) &&
  (!x.section || new RegExp(x.section, "i").test(e.section ?? ""));

const moss = new MossPicker(undefined, 0); // gap 0: record raw scores, sweep below
const claudes = claudeSpecs.map((s) => new ClaudePicker(parseClaudeConfig(s)));

const rows: Row[] = [];
const record = (picker: string, snap: string, intent: string, truth: Set<number>, r: Awaited<ReturnType<MossPicker["pick"]>>) => {
  rows.push(
    r.ok
      ? { picker, snap, intent, correct: truth.has(r.data.idx), trusted: r.data.trusted, gap: r.data.score - (r.data.runnerUpScore ?? 0), latencyMs: r.data.latencyMs, indexMs: r.data.indexMs ?? 0 }
      : { picker, snap, intent, correct: false, trusted: false, gap: 0, latencyMs: 0, indexMs: 0, error: r.error.message },
  );
  process.stdout.write(rows.at(-1)!.correct ? "." : "x");
};

let cases = 0;
for (const s of snaps) {
  for (const t of tasks.filter((t) => t.pageType === s.pageType)) {
    const truth = new Set(s.state.elements.filter((e) => matches(e, t.expect)).map((e) => e.idx));
    if (!truth.size) continue; // control not on this page: no ground truth
    cases++;
    const step: FindStep = { kind: "find_control", intent: t.intent, then: t.then };
    for (const a of ALPHAS) {
      moss.alpha = a; // same per-page index, different query weighting
      record(`moss α=${a}`, s.file, t.intent, truth, await moss.pick(s.state, step));
    }
    // Claude configs in parallel per case: latency is per call, so this only saves wall-clock.
    const rs = await Promise.all(claudes.map((c) => c.pick(s.state, step)));
    rs.forEach((r, i) => record(claudes[i]!.label, s.file, t.intent, truth, r));
  }
}
console.log(`\n\n${cases} cases over ${snaps.length} snapshots\n`);

const pct = (a: number[], q: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))]! : 0);
const accOf = (rs: Row[]) => (100 * rs.filter((r) => r.correct).length) / (rs.length || 1);
const names = [...new Set(rows.map((r) => r.picker))];
console.log("picker                         acc    p50 ms   p95 ms   index/page p50   errors");
for (const name of names) {
  const rs = rows.filter((r) => r.picker === name);
  const lat = rs.filter((r) => !r.error).map((r) => r.latencyMs);
  const idx = rs.filter((r) => r.indexMs > 0).map((r) => r.indexMs);
  console.log(
    `${name.padEnd(30)} ${accOf(rs).toFixed(0).padStart(3)}%  ${pct(lat, 0.5).toFixed(1).padStart(7)}  ${pct(lat, 0.95).toFixed(1).padStart(7)}   ${idx.length ? `${pct(idx, 0.5).toFixed(0)} ms`.padStart(14) : "".padStart(14)}   ${rs.filter((r) => r.error).length}`,
  );
}

// Per moss α: smallest gap where every trusted pick is correct, and its coverage.
console.log("\nMOSS_GAP sweep (smallest G with zero wrong trusted clicks):");
const bestGap: Record<string, { g: number; coverage: number } | undefined> = {};
for (const name of names.filter((n) => n.startsWith("moss"))) {
  const rs = rows.filter((r) => r.picker === name && !r.error);
  for (const g of [0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5]) {
    const trusted = rs.filter((r) => r.gap >= g);
    if (trusted.every((r) => r.correct)) {
      bestGap[name] = { g, coverage: (100 * trusted.length) / (rs.length || 1) };
      break;
    }
  }
  const b = bestGap[name];
  console.log(`  ${name.padEnd(12)} ${b ? `G=${b.g}  coverage ${b.coverage.toFixed(0)}% of steps handled by Moss alone` : "no safe gap"}`);
}

// Simulated chains: each moss α at its safe gap, falling back to each Claude config.
const claudeNames = names.filter((n) => !n.startsWith("moss"));
if (claudeNames.length) {
  console.log("\nchain simulation (moss at safe gap → claude):");
  for (const m of names.filter((n) => n.startsWith("moss"))) {
    const b = bestGap[m];
    if (!b) continue;
    for (const c of claudeNames) {
      const cRows = new Map(rows.filter((r) => r.picker === c).map((r) => [`${r.snap}|${r.intent}`, r]));
      let correct = 0, ms = 0, n = 0;
      for (const r of rows.filter((r) => r.picker === m)) {
        n++;
        const mossMs = r.latencyMs + r.indexMs / 5; // index cost is per page, shared by ~5 steps
        if (!r.error && r.gap >= b.g) {
          correct += +r.correct;
          ms += mossMs;
        } else {
          const cr = cRows.get(`${r.snap}|${r.intent}`);
          correct += +(cr?.correct ?? false);
          ms += mossMs + (cr?.latencyMs ?? 0);
        }
      }
      console.log(`  ${m.padEnd(12)} → ${c.padEnd(26)} acc ${((100 * correct) / n).toFixed(0)}%  mean ${(ms / n).toFixed(0)} ms/step`);
    }
  }
}

writeFileSync("bench/results.json", JSON.stringify(rows, null, 1));
console.log("\nwrong picks (moss α=0.8 + claude configs):");
for (const r of rows.filter((r) => !r.correct && (r.picker === "moss α=0.8" || !r.picker.startsWith("moss"))))
  console.log(`  ${r.picker} ${r.snap} "${r.intent}"${r.error ? ` (${r.error})` : ""}`);
await moss.close();
