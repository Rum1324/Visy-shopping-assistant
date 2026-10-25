import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DriverRequest, ProductCandidate, type ServerMsg } from "@visy/contracts";
import { ExtensionDriver } from "../src/navigator/driver/extension.ts";
import { liveServices } from "../src/live.ts";
import { PAGE_SCRIPTS, type ScriptName } from "../src/navigator/scripts.ts";
import { walmartCandidates, walmartDetail, type WalmartDetail, type WalmartResult } from "../src/navigator/sites/walmart.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const SEARCH = fixture("walmart-search-picnic-blanket.json");
const PRODUCT = fixture("walmart-product-1615978032.json");

/** Runs a named page script against a page whose only content is a __NEXT_DATA__ script. */
function runScript<T>(name: ScriptName, nextData: string, path = "/search"): T {
  const document = { readyState: "complete", getElementById: (id: string) => (id === "__NEXT_DATA__" ? { textContent: nextData } : null) };
  return new Function("document", "location", "arg", `return (${PAGE_SCRIPTS[name]});`)(document, { pathname: path }, null);
}

test("walmart.results reads the saved search page: grid first, deduped, sponsored flagged", () => {
  const rows = runScript<WalmartResult[]>("walmart.results", SEARCH);
  // Grid stacks first (both of them), then the "4 stars and above" carousel; REDCAMP appears twice but is kept once.
  assert.deepEqual(rows.map((r) => r.id), ["15344621454", "1615978032", "5246379261", "20833016344", "10136974391", "20763050993", "152971497", "176870221"]);
  const ozark = rows.find((r) => r.id === "1615978032")!;
  assert.equal(ozark.price, "20.62");
  assert.equal(ozark.wasPrice, "25.68");
  assert.deepEqual(ozark.flags, [{ key: "ROLLBACK", text: "Rollback" }]);
  assert.equal(ozark.delivery, "Shipping, arrives tomorrow");
  assert.equal(ozark.path, "/ip/Ozark-Trail-Packable-Blanket-70-x-60-in-Gradient-Design-for-Camping-Travel-Picnics/1615978032");
  assert.equal(ozark.sponsored, false);
  assert.equal(rows[0]!.sponsored, true);
  assert.equal(rows.find((r) => r.id === "20763050993")!.rating, null);
  assert.deepEqual(runScript("walmart.results", "not json"), []);
});

test("walmartCandidates: organic only, with was price, rollback/clearance deals and delivery", () => {
  const cands = walmartCandidates(runScript<WalmartResult[]>("walmart.results", SEARCH));
  assert.deepEqual(cands.map((c) => c.id), ["walmart:1615978032", "walmart:5246379261", "walmart:20763050993", "walmart:176870221"]);
  for (const c of cands) ProductCandidate.parse(c);
  const [ozark, airensky, suxu, cowin] = cands as [ProductCandidate, ProductCandidate, ProductCandidate, ProductCandidate];
  assert.equal(ozark.url, "https://www.walmart.com/ip/Ozark-Trail-Packable-Blanket-70-x-60-in-Gradient-Design-for-Camping-Travel-Picnics/1615978032");
  assert.deepEqual(ozark.price, { cents: 2062, currency: "USD" });
  assert.deepEqual(ozark.listPrice, { cents: 2568, currency: "USD" });
  assert.deepEqual(ozark.deal, { label: "Rollback" });
  assert.equal(ozark.rating, 4.5);
  assert.equal(ozark.reviewCount, 714);
  assert.equal(ozark.inStock, true);
  assert.deepEqual(ozark.shipping, { eta: "Shipping, arrives tomorrow", free: false });
  assert.match(ozark.imageUrls[0]!, /^https:\/\/i5\.walmartimages\.com\//);
  // "In 25+ people's carts" and "Best seller" are not deals; a was price alone still shows as listPrice.
  assert.equal(airensky.deal, undefined);
  assert.deepEqual(airensky.listPrice, { cents: 2499, currency: "USD" });
  assert.equal(cowin.deal, undefined);
  assert.equal(suxu.rating, undefined);
  assert.equal(suxu.shipping?.free, true);
  assert.equal(walmartCandidates(runScript<WalmartResult[]>("walmart.results", SEARCH), 2).length, 2);
});

test("walmart.detail reads the saved product page into a ProductDetail with retailer reviews", () => {
  const raw = runScript<WalmartDetail>("walmart.detail", PRODUCT, "/ip/1615978032");
  const cand = walmartCandidates(runScript<WalmartResult[]>("walmart.results", SEARCH))[0]!;
  const d = walmartDetail(cand, raw);
  assert.equal(d.title, "Ozark Trail Packable Blanket, 70 in x 60 in, Gradient Design, for Camping, Travel and Picnics");
  assert.equal(d.brand, "Ozark Trail");
  assert.deepEqual(d.price, { cents: 2062, currency: "USD" });
  assert.deepEqual(d.listPrice, { cents: 2568, currency: "USD" });
  assert.deepEqual(d.deal, { label: "Rollback, save $5.06" });
  assert.equal(d.imageUrls.length, 3);
  assert.equal(d.bullets.length, 5);
  assert.match(d.bullets[0]!, /^The upper layer is soft and breathable/);
  assert.match(d.description, /^This Ozark Trail packable blanket/);
  assert.equal(d.specs["Size"], '60" x 70"');
  assert.deepEqual(d.variants, [
    { name: "Actual Color", options: ["Blue", "Gradient", "Grey", "Mountain"] },
    { name: "Pack Size", options: ["Single", "2 Pack"] },
  ]);
  assert.equal(d.retailerReviews.length, 3);
  const r = d.retailerReviews[0]!;
  assert.equal(r.id, "walmart:442132068");
  assert.equal(r.productId, "walmart:1615978032");
  assert.equal(r.date, "2026-09-28T00:00:00.000Z");
  assert.equal(r.verifiedPurchase, true);
  assert.equal(r.untrusted, true);
  assert.equal(d.retailerReviews[2]!.verifiedPurchase, false);
  assert.equal(runScript("walmart.detail", "{}"), null);
});

test("NAV=amazon Walmart search and detail run live in the extension's Chrome, in background tabs", async () => {
  process.env.PICKER_CHAIN = "";
  const sent: DriverRequest[] = [];
  let tabs = 70;
  const driver: ExtensionDriver = new ExtensionDriver((msg: ServerMsg) => {
    if (msg.type !== "driver.request") return;
    const req = DriverRequest.parse(msg.req);
    sent.push(req);
    const value =
      req.op !== "extract" ? undefined
      : req.name === "walmart.results" ? runScript("walmart.results", SEARCH)
      : req.name === "walmart.detail" ? runScript("walmart.detail", PRODUCT, "/ip/1615978032")
      : "https://www.walmart.com/search Walmart.com"; // blockProbe: not blocked
    const data =
      req.op === "openTab" ? { tabId: tabs++ }
      : req.op === "navigate" ? { url: req.url }
      : req.op === "waitFor" ? { met: true }
      : req.op === "extract" ? { value }
      : {};
    setImmediate(() => driver.handle({ type: "driver.response", id: msg.id, ok: true, data }));
  }, 500);
  const services = liveServices({ driver: () => driver });
  const r = await services.navigator.search({ query: "picnic blanket" } as never, "walmart", () => {});
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.data[0]!.id, "walmart:1615978032");
  assert.deepEqual(sent[0], { op: "openTab", url: "about:blank", background: true });
  assert.ok(sent.some((q) => q.op === "navigate" && q.url === "https://www.walmart.com/search?q=picnic%20blanket"));
  assert.ok(sent.every((q) => q.op !== "extract" || q.name in PAGE_SCRIPTS));
  assert.ok(sent.every((q) => q.op !== "openTab" || q.background));

  const d = await services.navigator.getDetail(r.data[0]!, () => {});
  assert.ok(d.ok, JSON.stringify(d));
  assert.equal(d.data.retailerReviews.length, 3);
  assert.ok(sent.some((q) => q.op === "navigate" && q.url === r.data[0]!.url));
});
