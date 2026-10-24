/**
 * C2: getDetail on a real Amazon product, prints the retailer review count, a sample and timings.
 *   npm run reviews -w @visy/server -- "picnic blanket"     # search, take the first organic result
 *   npm run reviews -w @visy/server -- B0XXXXXXXX           # a specific ASIN
 *   npm run reviews -w @visy/server -- --login "picnic blanket"   # first opens Amazon sign-in; you sign in, press Enter
 * Full review pages need a signed-in profile. Signed out you get the product page's ~13 top reviews.
 */
import { createInterface } from "node:readline/promises";
import { productId } from "@visy/contracts";
import { PlaywrightDriver } from "../src/navigator/driver/playwright.ts";
import { AmazonFlow } from "../src/navigator/sites/amazon.ts";

const arg = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "picnic blanket";
const driver = new PlaywrightDriver();
const waitForHuman = async () => {
  console.log("\n⚠️  Bot check in the browser window. Please solve it there, then press Enter here.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("");
  rl.close();
};
const flow = new AmazonFlow(driver, [], undefined, waitForHuman);

try {
  if (process.argv.includes("--login")) {
    const t = await driver.openTab("https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0");
    if (t.ok) flow.tabId = t.data.tabId;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Sign in to Amazon in the browser window (leave it open), then press Enter here.");
    rl.close();
  }
  let asin = /^[A-Z0-9]{10}$/.test(arg) ? arg : undefined;
  let title = asin ?? "";
  if (!asin) {
    const s = await flow.search(arg);
    if (!s.ok) throw new Error(`search: ${s.error.message}`);
    const pick = s.data.find((r) => !r.sponsored) ?? s.data[0]!;
    asin = pick.asin;
    title = pick.title;
  }
  console.log(`product: ${asin}  ${title.slice(0, 80)}`);

  // Reviews alone first (timing for the README), then the whole getDetail.
  const t0 = performance.now();
  const rv = await flow.reviews(asin);
  const reviewsMs = Math.round(performance.now() - t0);
  if (!rv.ok) throw new Error(`reviews: ${rv.error.code} ${rv.error.message}`);
  if (rv.data.gated) console.log("⚠️  Review pages need sign-in on this profile; fell back to the product page's top reviews.");
  console.log(`reviews: ${rv.data.reviews.length} via ${rv.data.via}, ${rv.data.pages} page(s), ${reviewsMs} ms ${JSON.stringify(flow.marks)}`);

  const t1 = performance.now();
  const candidate = {
    id: productId("amazon", asin),
    marketplace: "amazon" as const,
    url: `https://www.amazon.com/dp/${asin}`,
    title,
    price: { cents: 0, currency: "USD" as const },
    imageUrls: [],
    source: { via: "recipe" as const, confidence: 1, fetchedAt: new Date().toISOString() },
  };
  const d = await flow.getDetail(candidate);
  const detailMs = Math.round(performance.now() - t1);
  if (!d.ok) throw new Error(`getDetail: ${d.error.message}`);
  const rr = d.data.retailerReviews;
  const complete = rr.filter((r) => r.rating !== undefined && r.title && r.body && r.date && r.source === "retailer").length;
  console.log(`getDetail: ${rr.length} retailerReviews (${complete} with rating+title+body+date), ${d.data.bullets.length} bullets, ${detailMs} ms`);
  for (const r of rr.slice(0, 3)) {
    // Untrusted text: printed as data, truncated.
    console.log(`  ★${r.rating} ${r.date?.slice(0, 10)} ${r.verifiedPurchase ? "verified " : ""}"${r.title}" ${JSON.stringify(r.body.slice(0, 160))}`);
  }
  if (rr.length < 30) process.exitCode = 2;
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP_OPEN) await driver.close();
}
