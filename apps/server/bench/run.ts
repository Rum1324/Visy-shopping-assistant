/**
 * Offline picker bake-off (ARCHITECTURE §4a) on saved snapshots. Nothing hits the retailers.
 *   npm run bench -w @visy/server                 # moss + claude
 *   npm run bench -w @visy/server -- --no-claude  # moss only (free, fast)
 * Prints accuracy / latency per picker, sweeps MOSS_GAP, and simulates the moss→claude chain.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ElementPicker, PageElement, PageState } from "@visy/contracts";
import { MossPicker } from "../src/navigator/pickers/moss.ts";
import { ClaudePicker } from "../src/navigator/pickers/claude.ts";
import type { FindStep } from "../src/navigator/pickers/common.ts";

type Task = { pageType: string; intent: string; then: FindStep["then"]; expect: { roles: string[]; name: string; section?: string } };
type Row = { picker: string; snap: string; intent: string; correct: boolean; trusted: boolean; gap: number; latencyMs: number; indexMs: number; error?: string };

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

const pickers: ElementPicker[] = [new MossPicker(undefined, 0)]; // gap 0: record raw scores, sweep below
if (!process.argv.includes("--no-claude")) pickers.push(new ClaudePicker());

const rows: Row[] = [];
for (const s of snaps) {
  for (const t of tasks.filter((t) => t.pageType === s.pageType)) {
    const truth = new Set(s.state.elements.filter((e) => matches(e, t.expect)).map((e) => e.idx));
    if (!truth.size) continue; // control not on this page: no ground truth
    const step: FindStep = { kind: "find_control", intent: t.intent, then: t.then };
    for (const p of pickers) {
      const r = await p.pick(s.state, step);
      rows.push(
        r.ok
          ? { picker: p.name, snap: s.file, intent: t.intent, correct: truth.has(r.data.idx), trusted: r.data.trusted, gap: r.data.score - (r.data.runnerUpScore ?? 0), latencyMs: r.data.latencyMs, indexMs: r.data.indexMs ?? 0 }
          : { picker: p.name, snap: s.file, intent: t.intent, correct: false, trusted: false, gap: 0, latencyMs: 0, indexMs: 0, error: r.error.message },
      );
      process.stdout.write(rows.at(-1)!.correct ? "." : "x");
    }
  }
}
console.log("\n");

const pct = (a: number[], q: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))]! : 0);
for (const name of new Set(rows.map((r) => r.picker))) {
  const rs = rows.filter((r) => r.picker === name);
  const lat = rs.filter((r) => !r.error).map((r) => r.latencyMs);
  const idx = rs.filter((r) => r.indexMs > 0).map((r) => r.indexMs);
  console.log(
    `${name.padEnd(7)} n=${rs.length}  top-1 acc ${((100 * rs.filter((r) => r.correct).length) / rs.length).toFixed(0)}%  ` +
      `pick p50 ${pct(lat, 0.5).toFixed(1)} ms p95 ${pct(lat, 0.95).toFixed(1)} ms` +
      (idx.length ? `  index/page p50 ${pct(idx, 0.5).toFixed(0)} ms p95 ${pct(idx, 0.95).toFixed(0)} ms` : "") +
      `  errors ${rs.filter((r) => r.error).length}`,
  );
}

// GAP sweep: smallest gap where every trusted moss pick is correct.
const moss = rows.filter((r) => r.picker === "moss" && !r.error);
console.log("\nMOSS_GAP sweep (trusted = gap ≥ G):");
let best: number | undefined;
for (const g of [0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3]) {
  const trusted = moss.filter((r) => r.gap >= g);
  const wrong = trusted.filter((r) => !r.correct).length;
  if (wrong === 0 && best === undefined) best = g;
  console.log(`  G=${g.toFixed(2)}  coverage ${((100 * trusted.length) / (moss.length || 1)).toFixed(0)}%  wrong clicks ${wrong}`);
}
console.log(best === undefined ? "  no gap gives zero wrong clicks: use memory + claude only" : `  → recommended MOSS_GAP=${best}`);

// Simulated chain: moss at the recommended gap, else claude.
const claude = new Map(rows.filter((r) => r.picker === "claude").map((r) => [`${r.snap}|${r.intent}`, r]));
if (best !== undefined && claude.size) {
  let correct = 0, ms = 0, claudeCalls = 0;
  for (const m of moss) {
    if (m.gap >= best) {
      correct += +m.correct;
      ms += m.latencyMs + m.indexMs;
    } else {
      const c = claude.get(`${m.snap}|${m.intent}`);
      claudeCalls++;
      correct += +(c?.correct ?? false);
      ms += m.latencyMs + m.indexMs + (c?.latencyMs ?? 0);
    }
  }
  const claudeOnly = [...claude.values()];
  console.log(
    `\nchain moss→claude: acc ${((100 * correct) / moss.length).toFixed(0)}%  mean ${(ms / moss.length).toFixed(0)} ms/step  claude on ${((100 * claudeCalls) / moss.length).toFixed(0)}% of steps` +
      `\nclaude only:       acc ${((100 * claudeOnly.filter((r) => r.correct).length) / claudeOnly.length).toFixed(0)}%  mean ${(claudeOnly.reduce((a, r) => a + r.latencyMs, 0) / claudeOnly.length).toFixed(0)} ms/step`,
  );
}

writeFileSync("bench/results.json", JSON.stringify(rows, null, 1));
console.log("\nrows → bench/results.json, wrong picks:");
for (const r of rows.filter((r) => !r.correct)) console.log(`  ${r.picker} ${r.snap} "${r.intent}"${r.error ? ` (${r.error})` : ""}`);
for (const p of pickers) if (p instanceof MossPicker) await p.close();
