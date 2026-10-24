/**
 * Saves real PageStates for the offline bench: search + first product page per query, per site.
 *   npm run snap -w @visy/server [-- amazon walmart target]
 * If a bot check shows up: in a terminal you're asked to solve it in the window; otherwise the page is skipped.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { PlaywrightDriver } from "../src/navigator/driver/playwright.ts";

const QUERIES = ["picnic blanket", "usb c cable", "seaweed snacks"];
const SITES = {
  amazon: { search: (q: string) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`, product: /\/dp\/[A-Z0-9]{10}/ },
  walmart: { search: (q: string) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`, product: /\/ip\// },
  target: { search: (q: string) => `https://www.target.com/s?searchTerm=${encodeURIComponent(q)}`, product: /\/p\/.+\/-\/A-\d+/ },
} as const;
type Site = keyof typeof SITES;

const sites = (process.argv.slice(2).filter((a) => a in SITES) as Site[]).concat();
const run = sites.length ? sites : (Object.keys(SITES) as Site[]);
const OUT = "bench/snapshots";
mkdirSync(OUT, { recursive: true });

const driver = new PlaywrightDriver();
const slug = (s: string) => s.replace(/\W+/g, "-");

async function snapTo(tabId: number, file: string, pageType: string) {
  await driver.page(tabId)!.waitForTimeout(2500); // let SPAs render
  let s = await driver.snapshot(tabId);
  if (!s.ok && s.error.code === "blocked" && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(`Bot check on ${file}. Solve it in the window, then press Enter (or Ctrl-C).`);
    rl.close();
    s = await driver.snapshot(tabId);
  }
  if (!s.ok) {
    console.log(`  skip ${file}: ${s.error.code} ${s.error.message}`);
    return undefined;
  }
  writeFileSync(`${OUT}/${file}.json`, JSON.stringify({ pageType, state: s.data }, null, 1));
  console.log(`  saved ${file} (${s.data.elements.length} elements)`);
  return s.data;
}

const tab = await driver.openTab("about:blank");
if (!tab.ok) throw new Error(tab.error.message);
const tabId = tab.data.tabId;
for (const site of run) {
  console.log(site);
  for (const q of QUERIES) {
    await driver.navigate(tabId, SITES[site].search(q));
    const state = await snapTo(tabId, `${site}-search-${slug(q)}`, `${site}-search`);
    if (!state) continue;
    const link = state.elements.find((e) => e.href && SITES[site].product.test(e.href) && e.name.length > 15 && !/sponsored/i.test(e.section ?? ""));
    if (!link?.href) {
      console.log("  no product link found");
      continue;
    }
    await driver.navigate(tabId, link.href);
    await snapTo(tabId, `${site}-product-${slug(q)}`, `${site}-product`);
  }
}
await driver.close();
