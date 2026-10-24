/**
 * Offline picker bake-off (ARCHITECTURE §4a, TRACKS-CD C1a) on saved snapshots. Nothing hits the retailers.
 *   npm run bench -w @visy/server                                  # Moss variants + Haiku fallback
 *   npm run bench -w @visy/server -- --no-claude                   # Moss only; chain uses bench/claude-cache.json
 *   npm run bench -w @visy/server -- --moss=0.2:0,0.2:30,0.8:0     # α:prefilterK variants (K=0 → all 150)
 *   npm run bench -w @visy/server -- --claude=claude-haiku-5-5:low:off,claude-opus-5-5:low:on
 * Per Moss variant: top-1 accuracy, whether the prefilter kept a correct element, the smallest safe MOSS_GAP
 * (0 wrong trusted clicks) and its coverage, embedding time per step / per page, and the moss→claude chain.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PageElement, PageState } from "@visy/contracts";
import { MossPicker } from "../src/navigator/pickers/moss.ts";
import { ClaudePicker, parseClaudeConfig } from "../src/navigator/pickers/claude.ts";
import { candidates, prefilter, type FindStep } from "../src/navigator/pickers/common.ts";

type Task = { pageType: string; intent: string; then: FindStep["then"]; expect: { roles: string[]; name: string; section?: string } };
type Row = { picker: string; snap: string; intent: string; correct: boolean; trusted: boolean; gap: number; latencyMs: number; indexMs: number; inPool?: boolean; error?: string };

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const claudeSpecs = process.argv.includes("--no-claude") ? [] : (arg("claude")?.split(",") ?? ["claude-haiku-5-5:low:off"]);
const mossSpecs = (arg("moss") ?? "0.2:0,0.2:50,0.2:30,0.2:20,0.2:15").split(",").map((s) => {
  const [a, k] = s.split(":");
  return { alpha: Number(a), k: Number(k ?? 0) };
});
const CACHE = "bench/claude-cache.json"; // Claude's per-case results don't depend on Moss, so chain sims can reuse them

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

const label = (v: { alpha: number; k: number }) => `moss α=${v.alpha} ${v.k ? `top${v.k}` : "all150"}`;
// Separate pickers (and Moss sessions), so each variant pays its own embedding cost. Gap 0: record raw scores.
const mosses = mossSpecs.map((v) => ({ label: label(v), k: v.k, picker: new MossPicker(undefined, 0, v.alpha, 150, v.k) }));
const claudes = claudeSpecs.map((s) => new ClaudePicker(parseClaudeConfig(s)));
await Promise.all(mosses.map((m) => m.picker.warm())); // model load is not part of per-page cost

const rows: Row[] = [];
let cases = 0;
for (const s of snaps) {
  for (const t of tasks.filter((t) => t.pageType === s.pageType)) {
    const truth = new Set(s.state.elements.filter((e) => matches(e, t.expect)).map((e) => e.idx));
    if (!truth.size) continue; // control not on this page: no ground truth
    cases++;
    const step: FindStep = { kind: "find_control", intent: t.intent, then: t.then };
    for (const m of mosses) {
      const pool = prefilter(candidates(s.state, step).slice(0, 150), step, m.k);
      const inPool = pool.some((e) => truth.has(e.idx));
      const r = await m.picker.pick(s.state, step);
      rows.push(
        r.ok
          ? { picker: m.label, snap: s.file, intent: t.intent, correct: truth.has(r.data.idx), trusted: r.data.trusted, gap: r.data.score - (r.data.runnerUpScore ?? 0), latencyMs: r.data.latencyMs, indexMs: r.data.indexMs ?? 0, inPool }
          : { picker: m.label, snap: s.file, intent: t.intent, correct: false, trusted: false, gap: -1, latencyMs: 0, indexMs: 0, inPool, error: r.error.message },
      );
    }
    const rs = await Promise.all(claudes.map((c) => c.pick(s.state, step)));
    rs.forEach((r, i) =>
      rows.push(
        r.ok
          ? { picker: claudes[i]!.label, snap: s.file, intent: t.intent, correct: truth.has(r.data.idx), trusted: r.data.trusted, gap: 0, latencyMs: r.data.latencyMs, indexMs: 0 }
          : { picker: claudes[i]!.label, snap: s.file, intent: t.intent, correct: false, trusted: false, gap: 0, latencyMs: 0, indexMs: 0, error: r.error.message },
      ),
    );
    process.stdout.write(".");
  }
}
console.log(`\n\n${cases} cases over ${snaps.length} snapshots\n`);

let claudeRows = rows.filter((r) => !r.picker.startsWith("moss"));
if (claudeRows.length) writeFileSync(CACHE, JSON.stringify(claudeRows, null, 1));
else if (existsSync(CACHE)) {
  claudeRows = JSON.parse(readFileSync(CACHE, "utf8"));
  console.log(`(Claude rows from ${CACHE}, not re-run)\n`);
}

const pct = (a: number[], q: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))]! : 0);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const GAPS = [0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5];

console.log("variant               top-1  target kept  safe gap  coverage@0.1  wrong@0.1  embed/step  embed/page  query p50");
for (const m of mosses) {
  const rs = rows.filter((r) => r.picker === m.label);
  const ok = rs.filter((r) => !r.error);
  const g = GAPS.find((g) => ok.filter((r) => r.gap >= g).every((r) => r.correct));
  const coverage = (100 * ok.filter((r) => r.gap >= 0.1).length) / rs.length;
  const wrongAt01 = ok.filter((r) => r.gap >= 0.1 && !r.correct).length;
  const perPage = new Map<string, number>();
  for (const r of rs) perPage.set(r.snap, (perPage.get(r.snap) ?? 0) + r.indexMs);
  console.log(
    `${m.label.padEnd(20)} ${`${((100 * rs.filter((r) => r.correct).length) / rs.length).toFixed(0)}%`.padStart(5)}  ${`${rs.filter((r) => r.inPool).length}/${rs.length}`.padStart(11)}  ${String(g ?? "none").padStart(8)}  ${`${coverage.toFixed(0)}%`.padStart(12)}  ${String(wrongAt01).padStart(9)}  ${`${mean(rs.map((r) => r.indexMs)).toFixed(0)} ms`.padStart(10)}  ${`${mean([...perPage.values()]).toFixed(0)} ms`.padStart(10)}  ${`${pct(ok.map((r) => r.latencyMs), 0.5).toFixed(1)} ms`.padStart(9)}`,
  );
}
for (const c of new Set(claudeRows.map((r) => r.picker))) {
  const rs = claudeRows.filter((r) => r.picker === c);
  console.log(`${c.padEnd(20)} ${`${((100 * rs.filter((r) => r.correct).length) / rs.length).toFixed(0)}%`.padStart(5)}  wrong clicks ${rs.filter((r) => !r.correct && !r.error).length}, no answer ${rs.filter((r) => r.error).length}, p50 ${pct(rs.filter((r) => !r.error).map((r) => r.latencyMs), 0.5).toFixed(0)} ms`);
}

// Chain: Moss at MOSS_GAP=0.1 (the production setting), else Claude. Wrong clicks are the number that must stay 0.
if (claudeRows.length) {
  console.log("\nchain at MOSS_GAP=0.1 → Claude:");
  for (const m of mosses) {
    for (const c of new Set(claudeRows.map((r) => r.picker))) {
      const cRows = new Map(claudeRows.filter((r) => r.picker === c).map((r) => [`${r.snap}|${r.intent}`, r]));
      let correct = 0, wrong = 0, ms = 0, claudeCalls = 0;
      const rs = rows.filter((r) => r.picker === m.label);
      for (const r of rs) {
        ms += r.latencyMs + r.indexMs;
        if (!r.error && r.gap >= 0.1) {
          correct += +r.correct;
          wrong += +!r.correct;
        } else {
          const cr = cRows.get(`${r.snap}|${r.intent}`);
          claudeCalls++;
          ms += cr?.latencyMs ?? 0;
          correct += +(cr?.correct ?? false);
          wrong += +(cr && !cr.error && !cr.correct ? 1 : 0);
        }
      }
      console.log(`  ${m.label.padEnd(20)} → ${c}: acc ${((100 * correct) / rs.length).toFixed(0)}%  wrong clicks ${wrong}  claude on ${claudeCalls}/${rs.length} steps  mean ${(ms / rs.length).toFixed(0)} ms/step`);
    }
  }
}

writeFileSync("bench/results.json", JSON.stringify(rows, null, 1));
const misses = rows.filter((r) => r.picker.startsWith("moss") && r.gap >= 0.1 && !r.correct);
if (misses.length) {
  console.log("\nwrong trusted Moss picks at gap ≥ 0.1:");
  for (const r of misses) console.log(`  ${r.picker} ${r.snap} "${r.intent}" gap ${r.gap.toFixed(3)}`);
}
const dropped = rows.filter((r) => r.picker.startsWith("moss") && r.inPool === false);
if (dropped.length) {
  console.log("\nprefilter dropped every correct element:");
  for (const r of dropped) console.log(`  ${r.picker} ${r.snap} "${r.intent}"`);
}
for (const m of mosses) await m.picker.close();
