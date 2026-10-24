/**
 * End-to-end Amazon run: search → top results → open #1 → Add to Cart → read cart subtotal. Stops there.
 *   npm run demo -w @visy/server -- "picnic blanket" [--ui-search]
 *   PICKER_CHAIN=claude npm run demo ...      # slow baseline
 */
import { createInterface } from "node:readline/promises";
import { PlaywrightDriver } from "./navigator/driver/playwright.ts";
import { buildChain } from "./navigator/chain.ts";
import { AmazonFlow } from "./navigator/sites/amazon.ts";

const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith("--")) ?? "picnic blanket";
const viaUi = args.includes("--ui-search");

const chain = buildChain();
const driver = new PlaywrightDriver();
const waitForHuman = async () => {
  console.log("\n⚠️  Bot check in the browser window. Please solve it there, then press Enter here.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("");
  rl.close();
};
const flow = new AmazonFlow(driver, chain.pickers, chain.memory, waitForHuman);

const timings: Record<string, number> = {};
const time = async <T>(label: string, fn: () => Promise<T>) => {
  const t0 = performance.now();
  const r = await fn();
  timings[label] = Math.round(performance.now() - t0);
  if (process.env.PROFILE) console.log(`  ${label}: ${timings[label]} ms ${JSON.stringify(flow.marks)}`);
  return r;
};

const pickers = chain.pickers.map((p) => p.name).join(" → ");
const tWarm = performance.now();
// What a running server / the extension already has: embedding model loaded (~2–7 s) and a browser tab open.
const [, tab] = await Promise.all([chain.moss?.warm(), driver.openTab("about:blank")]);
if (tab.ok) flow.tabId = tab.data.tabId;
console.log(`chain: ${pickers}  memory entries: ${(await chain.memory?.size()) ?? "-"}  warm-up ${Math.round(performance.now() - tWarm)} ms  query: "${query}"`);
const tStart = performance.now();
try {
  const results = await time("search", () => flow.search(query, viaUi));
  if (!results.ok) throw new Error(results.error.message);
  const organic = results.data.filter((r) => !r.sponsored);
  console.log("\nTop results:");
  for (const r of organic.slice(0, 3)) console.log(`  ${r.asin}  ${r.price ?? "?"}  ${r.rating ?? ""}  ${r.title.slice(0, 80)}`);
  const pick = organic[0] ?? results.data[0]!;

  const opened = await time("open product", () => flow.open(pick.asin));
  if (!opened.ok) throw new Error(opened.error.message);

  const added = await time("add to cart", () => flow.addToCart());
  if (!added.ok) throw new Error(added.error.message);
  console.log(`\nAdd to Cart picked by ${added.data.picker} (tried ${added.data.tried.join(" → ")}) in ${Math.round(added.data.latencyMs)} ms`);

  const cart = await time("view cart", () => flow.viewCart());
  if (cart.ok) console.log(`Cart subtotal: ${cart.data.subtotal || "(not shown)"}. Stopping here; the user places the order.`);
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  const total = Math.round(performance.now() - tStart);
  console.log("\nTimings (ms):", JSON.stringify({ ...timings, total }));
  console.log(`Claude calls: ${chain.claude?.calls ?? 0}`);
  await chain.close();
  if (!process.env.KEEP_OPEN) await driver.close();
}
