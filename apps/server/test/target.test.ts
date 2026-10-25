import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { chromium } from "playwright";
import { DriverRequest, type ServerMsg } from "@visy/contracts";
import { liveServices } from "../src/live.ts";
import { ExtensionDriver } from "../src/navigator/driver/extension.ts";
import type { RawDetail } from "../src/navigator/recipes.ts";
import { scriptCall, type ScriptName } from "../src/navigator/scripts.ts";
import { TARGET_PRODUCT_SEED, targetCandidate, targetFields, toTargetReviews, type TargetRow } from "../src/navigator/sites/target.ts";

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

// Bundled Chromium if installed, else the system Chrome; skip (not fail) on machines with neither.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" })).catch(() => null);
after(() => browser?.close());

async function run<T>(html: string, ...calls: [ScriptName, unknown?][]): Promise<T[]> {
  const page = await browser!.newPage();
  await page.setContent(html);
  const out: T[] = [];
  for (const [name, arg] of calls) out.push(await page.evaluate(scriptCall(name, arg)));
  await page.close();
  return out;
}

test("target.results reads live search cards; sponsored dropped; sale, clearance and delivery parsed", { skip: !browser && "no Chromium for Playwright" }, async () => {
  const [ready, full, rows] = await run<unknown>(fixture("target-search.html"), ["target.resultsReady"], ["target.cardsReady"], ["target.results"]);
  assert.equal(ready, true);
  assert.equal(full, false, "5 cards < 20");
  const r = rows as TargetRow[];
  assert.equal(r.length, 5);
  assert.deepEqual(r.map((x) => x.sponsored), [true, false, false, false, false]);

  const c = r.map((x) => targetCandidate(x, "2026-10-24T20:00:00.000Z")).filter((x) => x !== null);
  assert.deepEqual(c.map((x) => x.id), ["target:A-94935705", "target:A-1014483528", "target:A-82099088", "target:A-91558607"]);

  const sale = c[3]!;
  assert.equal(sale.title, "Tirrinia Extra Large Picnic Blanket, Waterproof Lightweight Portable Outdoor Mat for Family Camping, Park, Beach, ( US Unique Print, 70''X80'')");
  assert.equal(sale.brand, "Tirrinia");
  assert.equal(sale.url, "https://www.target.com/p/tirrinia-extra-large-picnic-blanket-waterproof-lightweight-portable-outdoor-mat-for-family-camping-park-beach-us-unique-print-70-x80/-/A-91558607");
  assert.deepEqual(sale.price, { cents: 2999, currency: "USD" });
  assert.deepEqual(sale.listPrice, { cents: 3999, currency: "USD" });
  assert.equal(sale.deal?.label, "Sale");
  assert.equal(sale.rating, 4.8);
  assert.equal(sale.reviewCount, 20);
  assert.deepEqual(sale.shipping, { eta: "Shipping arrives Thu, Oct 29", free: true });
  assert.deepEqual(sale.imageUrls, ["https://target.scene7.com/is/image/Target/GUEST_2cb17d83-f2b9-43b4-af56-6d7660bcb523"]);
  assert.equal(sale.snippet, "Highly rated");

  const clearance = c[2]!;
  assert.deepEqual(clearance.price, { cents: 825, currency: "USD" });
  assert.equal(clearance.listPrice, undefined);
  assert.equal(clearance.deal?.label, "Select items on clearance");
  assert.equal(clearance.reviewCount, 2466);
  assert.match(clearance.snippet ?? "", /Price varies by option: \$8\.25 - \$20\.00/);

  const plain = c[0]!;
  assert.equal(plain.brand, "All In Motion");
  assert.equal(plain.deal, undefined);
  assert.equal(plain.snippet, "Bestseller");
  assert.equal(plain.inStock, true);
  assert.deepEqual(c[1]!.shipping, { eta: "Delivery as soon as 9am tomorrow; Shipping arrives Mon, Oct 26", free: undefined });
});

test("target product page: seed recipe, buy-box fulfillment and reviews, no zip", { skip: !browser && "no Chromium for Playwright" }, async () => {
  const [ready, raw, ful, rv] = await run<unknown>(
    fixture("target-product.html"),
    ["target.detailReady"],
    ["recipe.replay", TARGET_PRODUCT_SEED],
    ["target.fulfillment"],
    ["target.reviews"],
  );
  assert.equal(ready, true);
  assert.deepEqual(ful, ["Arrives by Thu, Oct 29", "Ships free with or $35 orders - exclusions apply"]);
  const f = targetFields(raw as RawDetail, ful as string[]);
  assert.match(f.title ?? "", /^Tirrinia Extra Large Picnic Blanket/);
  assert.equal(f.brand, "Tirrinia");
  assert.deepEqual(f.price, { cents: 2999, currency: "USD" });
  assert.deepEqual(f.listPrice, { cents: 3999, currency: "USD" });
  assert.equal(f.deal?.label, "$10 off");
  assert.equal(f.rating, 4.8);
  assert.equal(f.reviewCount, 20);
  assert.deepEqual(f.shipping, { eta: "Arrives by Thu, Oct 29", free: true });
  assert.equal(f.inStock, true);
  assert.equal(f.bullets.length, 3);
  assert.match(f.description ?? "", /^Tirrinia Extra-Large Picnic Blanket/);
  assert.equal(f.imageUrls.length, 3);
  assert.ok(f.imageUrls.every((u) => !u.includes("?")));
  assert.ok(!JSON.stringify(f).includes("ZIP"), "the user's zip never leaves the page");

  const url = "https://www.target.com/p/-/A-91558607";
  const reviews = toTargetReviews("91558607", url, rv as never);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.productId, "target:A-91558607");
  assert.equal(reviews[0]!.rating, 5);
  assert.equal(reviews[0]!.title, "Picnic Blanket");
  assert.equal(reviews[0]!.author, "Pooky Loo");
  assert.equal(reviews[0]!.date, "2026-07-05T00:00:00.000Z");
  assert.equal(reviews[0]!.verifiedPurchase, true);
  assert.equal(reviews[0]!.untrusted, true);
  assert.deepEqual(toTargetReviews("91558607", url, [...(rv as never[]), ...(rv as never[])]).length, 1, "same review twice → one id");
});

test("target.nextReviews reads the page JSON (background tabs never render review cards)", { skip: !browser && "no Chromium for Playwright" }, async () => {
  const [mine, any] = await run<never[]>(fixture("target-product.html"), ["target.nextReviews", "91558607"], ["target.nextReviews", "123"]);
  const reviews = toTargetReviews("91558607", "https://www.target.com/p/-/A-91558607", mine);
  assert.deepEqual(reviews.map((r) => [r.id, r.rating, r.author, r.date]), [
    ["target:91558607:d96357cf-6f9d-40c7-9ef4-e1aa9c75afa4", 5, "Pooky Loo", "2026-07-05T10:19:28.094Z"],
    ["target:91558607:92458522-143c-4f95-b9e4-bd95e91cef45", 4, "soziejmidwest5", "2026-03-04T02:00:05.000Z"],
  ]);
  assert.equal(reviews[1]!.title, "Very large and easy to repackage after use");
  assert.equal(reviews[0]!.verifiedPurchase, undefined);
  assert.equal(any.length, 1, "no tcin match → first product's reviews");
});

test("NAV=amazon routes Target search to live target.com in a background tab", async () => {
  process.env.PICKER_CHAIN = "";
  const sent: DriverRequest[] = [];
  const rows: TargetRow[] = [
    { tcin: "1", path: "/p/ad/-/A-1", title: "Ad blanket", brand: null, lines: ["$9.99", "Sponsored"], rating: null, image: null, sponsored: true },
    { tcin: "2", path: "/p/picnic/-/A-2", title: "Picnic Blanket", brand: "Sun Squad", lines: ["$25.00 reg $30.00", "Sale"], rating: "Average customer rating is 4.5 out of 5 stars with 12 reviews.", image: null, sponsored: false },
  ];
  const driver: ExtensionDriver = new ExtensionDriver((msg: ServerMsg) => {
    if (msg.type !== "driver.request") return;
    const req = DriverRequest.parse(msg.req);
    sent.push(req);
    const data =
      req.op === "openTab" ? { tabId: 7 }
      : req.op === "navigate" ? { url: req.url }
      : req.op === "waitFor" ? { met: true }
      : req.op === "extract" ? { value: req.name === "target.results" ? rows : "https://www.target.com/s Target" }
      : {};
    setImmediate(() => driver.handle({ type: "driver.response", id: msg.id, ok: true, data }));
  }, 500);
  const services = liveServices({ driver: () => driver });
  const r = await services.navigator.search({ query: "picnic blanket" } as never, "target", () => {});
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.data.map((c) => [c.id, c.price.cents, c.listPrice?.cents, c.deal?.label]), [["target:A-2", 2500, 3000, "Sale"]]);
  assert.deepEqual(sent[0], { op: "openTab", url: "about:blank", background: true });
  assert.ok(sent.some((q) => q.op === "navigate" && q.url === "https://www.target.com/s?searchTerm=picnic%20blanket"));
});
