/**
 * C1c bench: N Amazon tasks (search → open first organic result → locate Add to Cart, NOT clicked),
 * one tab after another vs. one tab + Moss session each, all at once.
 *   VISY_MEMORY_DIR=logs/mem-cold npm run parallel -w @visy/server -- --mode par --label cold
 *   PICKER_CHAIN=moss,claude ...   # skip memory so every tab embeds (CPU-contention check)
 * Appends one JSON row per run to logs/parallel-bench.jsonl.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { PlaywrightDriver } from "../src/navigator/driver/playwright.ts";
import { buildTabs, runParallel, runSequential, type TabReport } from "../src/navigator/parallel.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const mode = flag("mode") ?? "par";
const label = flag("label") ?? "";
const queries = args.length ? args : ["picnic blanket", "usb c cable", "seaweed snacks"];

const driver = new PlaywrightDriver();
const tabs = buildTabs(driver, mode === "par" ? queries.length : 1, async () => {
  // Never solved by us: wait for the human, polling every tab until none shows a bot check.
  console.log("\nBLOCKED: bot check in the browser window. Solve it there; waiting up to 10 min.");
  const end = Date.now() + 600_000;
  while (Date.now() < end) {
    const blocked = await Promise.all(tabs.workers.map((w) => (w.flow.tabId ? driver.isBlocked(w.flow.tabId) : false)));
    if (!blocked.some(Boolean)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
});

let reports: TabReport[] = [];
const tWarm = performance.now();
// What a running server already has: model loaded, tabs open. Tab 0 first: it launches the browser.
await tabs.workers[0]!.warm();
await Promise.all(tabs.workers.slice(1).map((w) => w.warm()));
const warmMs = Math.round(performance.now() - tWarm);
const memSize = (await tabs.memory?.size()) ?? 0;
console.log(`mode=${mode} ${label} chain=${process.env.PICKER_CHAIN ?? "memory,moss,claude"} memory=${memSize} warm-up=${warmMs} ms`);

const t0 = performance.now();
try {
  reports = mode === "par" ? await runParallel(tabs.workers, queries) : await runSequential(tabs.workers[0]!, queries);
} finally {
  const wallMs = Math.round(performance.now() - t0);
  console.log("\ntab query              search  open  locate  total | snaps snapMs embedMs pickers | picked");
  for (const r of reports) {
    const p = Object.entries(r.stats.pickerMs).map(([k, v]) => `${k}=${v}`).join(",");
    const what = r.ok ? `${r.picked!.role} "${r.picked!.name}" by ${r.picked!.picker}` : `✗ ${r.error}`;
    console.log(
      `${r.tab}   ${r.query.padEnd(18)} ${String(r.ms.search ?? "-").padStart(6)} ${String(r.ms.open ?? "-").padStart(5)} ${String(r.ms.locate ?? "-").padStart(7)} ${String(r.ms.total).padStart(6)} | ${String(r.stats.snapshots).padStart(5)} ${String(r.stats.snapshotMs).padStart(6)} ${String(r.stats.embedMs).padStart(7)} ${p} | ${what}`,
    );
  }
  const sum = reports.reduce((a, r) => a + r.ms.total!, 0);
  console.log(`\nwall=${wallMs} ms  (sum of tab totals ${sum} ms, slowest tab ${Math.max(0, ...reports.map((r) => r.ms.total!))} ms)`);
  console.log(`Claude calls: ${tabs.workers.reduce((a, w) => a + (w.claude?.calls ?? 0), 0)}`);
  mkdirSync("logs", { recursive: true });
  appendFileSync(
    "logs/parallel-bench.jsonl",
    JSON.stringify({ at: new Date().toISOString(), mode, label, chain: process.env.PICKER_CHAIN ?? "memory,moss,claude", memSize, warmMs, wallMs, reports }) + "\n",
  );
  await tabs.close();
  if (!process.env.KEEP_OPEN) await driver.close();
}
