/**
 * C3: getDetail on real Amazon products, printing how the details were read and how many Claude calls it took.
 *   npm run detail -w @visy/server -- "picnic blanket"        # first 2 organic results: A, A again, B
 *   npm run detail -w @visy/server -- B0XXXXXXXX B0YYYYYYYY   # these ASINs, in order
 * The first visit to a page type writes a recipe (1 Claude call, saved to data/recipes.json); later visits replay it.
 * VISY_PROFILE_DIR picks the Chrome profile (default .visy-profile); VISY_MEMORY_DIR the data dir.
 * RECIPE_FROM=recipe.json stands in for Claude's recipe call (still counted as a call), e.g. when the API is down.
 * OUTLINE_OUT=file.html also saves the pruned page outline Claude writes recipes from (for debugging recipes).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ok, productId } from "@visy/contracts";
import { PlaywrightDriver } from "../src/navigator/driver/playwright.ts";
import { AmazonFlow } from "../src/navigator/sites/amazon.ts";
import { ClaudeRecipeWriter, OUTLINE_JS, RecipeCache, RecipeFields, type RecipeWriter } from "../src/navigator/recipes.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const driver = new PlaywrightDriver({ profileDir: process.env.VISY_PROFILE_DIR });
const waitForHuman = async () => {
  console.log("\n⚠️  Bot check in the browser window. Please solve it there, then press Enter here.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("");
  rl.close();
};
const from = process.env.RECIPE_FROM;
const writer: RecipeWriter = from
  ? { calls: 0, async write() { this.calls++; return ok(RecipeFields.parse(JSON.parse(readFileSync(from, "utf8")))); } }
  : new ClaudeRecipeWriter();
const flow = new AmazonFlow(driver, [], undefined, waitForHuman, { cache: new RecipeCache(), writer });

try {
  let asins = args.filter((a) => /^[A-Z0-9]{10}$/.test(a));
  if (!asins.length) {
    const s = await flow.search(args[0] ?? "picnic blanket");
    if (!s.ok) throw new Error(`search: ${s.error.message}`);
    const organic = s.data.filter((r) => !r.sponsored);
    asins = [organic[0]!.asin, organic[0]!.asin, organic[1]!.asin];
  }
  let second: number | undefined;
  for (const [i, asin] of asins.entries()) {
    const t0 = performance.now();
    const d = await flow.getDetail({
      id: productId("amazon", asin),
      marketplace: "amazon",
      url: `https://www.amazon.com/dp/${asin}`,
      title: asin,
      price: { cents: 0, currency: "USD" },
      imageUrls: [],
      source: { via: "recipe", confidence: 1, fetchedAt: new Date().toISOString() },
    });
    if (!d.ok) throw new Error(`getDetail ${asin}: ${d.error.message}`);
    const x = flow.lastExtract!;
    if (process.env.OUTLINE_OUT) {
      const outline = await driver.evaluate<string>(flow.tabId!, `${OUTLINE_JS}(120000)`);
      appendFileSync(process.env.OUTLINE_OUT, `<!-- ${asin} -->\n${outline}\n`);
      console.log(`  outline: ${outline.length} chars → ${process.env.OUTLINE_OUT}`);
    }
    if (i === 1) second = x.claudeCalls;
    const p = d.data;
    console.log(`\nvisit ${i + 1} ${asin}: via ${x.via}, ${x.claudeCalls} Claude call(s), extract ${x.ms} ms, getDetail ${Math.round(performance.now() - t0)} ms`);
    // Untrusted page text: printed as data, truncated.
    console.log(`  ${JSON.stringify(p.title.slice(0, 70))} brand=${p.brand} price=${p.price.cents} list=${p.listPrice?.cents} deal=${JSON.stringify(p.deal?.label)}`);
    console.log(`  rating=${p.rating} reviews=${p.reviewCount} inStock=${p.inStock} shipping=${JSON.stringify(p.shipping)}`);
    console.log(`  ${p.bullets.length} bullets, ${Object.keys(p.specs).length} specs, ${p.imageUrls.length} images, banners=${JSON.stringify(p.banners)}`);
    console.log(`  variants=${JSON.stringify(p.variants.map((v) => `${v.name}: ${v.options.length}`))} retailerReviews=${p.retailerReviews.length}`);
    console.log(`  specs: ${JSON.stringify(Object.entries(p.specs).slice(0, 4))}  img0: ${p.imageUrls[0]}`);
  }
  if (second !== undefined) console.log(`\nsecond visit Claude calls: ${second}`);
  if (second) process.exitCode = 2;
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP_OPEN) await driver.close();
}
