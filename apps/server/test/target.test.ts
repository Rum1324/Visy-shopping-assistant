import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { chromium } from "playwright";
import { DriverRequest, type ServerMsg } from "@visy/contracts";
import { liveServices } from "../src/live.ts";
import { ExtensionDriver } from "../src/navigator/driver/extension.ts";
import type { FlowDriver } from "../src/navigator/driver/flow.ts";
import { RecipeCache, type RawDetail } from "../src/navigator/recipes.ts";
import { scriptCall, type ScriptName } from "../src/navigator/scripts.ts";
import { TARGET_PRODUCT_SEED, TargetFlow, targetCandidate, targetCheckout, targetFields, toTargetReviews, type NextItem, type TargetCart, type TargetRow } from "../src/navigator/sites/target.ts";
import type { ElementPicker, PageElement } from "@visy/contracts";

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

test("target.nextItem reads title, brand, highlights, description, images and specs from the page JSON", { skip: !browser && "no Chromium for Playwright" }, async () => {
  const [item] = await run<NextItem>(fixture("target-product.html"), ["target.nextItem", "91558607"]);
  assert.equal(item!.title, "Tirrinia Extra Large Picnic Blanket, Waterproof Lightweight Portable Outdoor Mat for Family Camping, Park, Beach, ( US Unique Print, 70''X80'')");
  assert.equal(item!.brand, "Tirrinia");
  assert.equal(item!.bullets.length, 2);
  assert.equal(item!.description, "Tirrinia Extra-Large Picnic Blanket – Adventure-Ready Comfort Your Essential Outdoor Companion, our 70\" x 80\" picnic blanket");
  assert.deepEqual(item!.images.length, 2);
  assert.deepEqual(item!.specs, [["Dimensions (Overall)", "80 inches (L), 70 inches (W)"], ["Weight", "2 pounds"], ["Material", "Polyester"]]);
});

test("TargetFlow.getDetail in its own background tab: no rendered price → search price stands, JSON fills the rest, no Claude call", async () => {
  const candidate = targetCandidate({ tcin: "91558607", path: "/p/x/-/A-91558607", title: "Tirrinia Picnic Blanket", brand: "Tirrinia", lines: ["$29.99 reg $39.99", "Sale", "Shipping arrives Thu, Oct 29", "Ships free - exclusions apply"], rating: "Average customer rating is 4.8 out of 5 stars with 20 reviews.", image: null, sponsored: false })!;
  const item: NextItem = { title: "Tirrinia Extra Large Picnic Blanket", brand: "Tirrinia", bullets: ["EXTRA LARGE", "MULTIPLE USE"], description: "Adventure-ready comfort", images: ["https://target.scene7.com/is/image/Target/GUEST_a"], specs: [["Weight", "2 pounds"]] };
  const json = [{ id: "r1", title: "Great", body: "Waterproof and big.", date: "2026-07-05T10:19:28.094Z", author: "A", rating: 5, verified: null, syndicated: false }];
  const unrendered = { title: "Tirrinia Extra Large Picnic Blanket", price: null, listPrice: null, deal: null, prime: null, rating: null, reviewCount: null, brand: null, availability: null, delivery: null, bullets: [], description: null, banners: [], images: [], specs: [], variants: [] };
  const values: Record<string, unknown> = { "target.nextItem": item, "recipe.replay": unrendered, "target.fulfillment": [], "target.nextReviews": json, blockProbe: "" };
  const driver = {
    openTab: async () => ({ ok: true, data: { tabId: 3 } }),
    navigate: async (_t: number, url: string) => ({ ok: true, data: { url } }),
    waitFor: async (_t: number, name: string) => name !== "target.priceReady",
    extract: async (_t: number, name: string) => values[name],
    isBlocked: async () => false,
    focus: async () => {},
    closeTab: async (tabId: number) => (closed.push(tabId), { ok: true, data: {} }),
  } as unknown as FlowDriver;
  const closed: number[] = [];
  const writer = { calls: 0, write: async () => { writer.calls++; return { ok: false, error: { code: "internal", message: "no", retryable: false } } as never; } };
  const flow = new TargetFlow(driver, () => {}, { cache: new RecipeCache("/nonexistent/recipes.json"), writer });
  const r = await flow.getDetail(candidate);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(writer.calls, 0);
  assert.equal(r.data.title, "Tirrinia Extra Large Picnic Blanket");
  assert.deepEqual([r.data.price.cents, r.data.listPrice?.cents, r.data.deal?.label], [2999, 3999, "Sale"]);
  assert.deepEqual([r.data.rating, r.data.reviewCount], [4.8, 20]);
  assert.deepEqual(r.data.shipping, { eta: "Shipping arrives Thu, Oct 29", free: true });
  assert.deepEqual(r.data.bullets, ["EXTRA LARGE", "MULTIPLE USE"]);
  assert.equal(r.data.description, "Adventure-ready comfort");
  assert.deepEqual(r.data.specs, { Weight: "2 pounds" });
  assert.deepEqual(r.data.retailerReviews.map((x) => x.id), ["target:91558607:r1"]);
  assert.deepEqual(closed, [3], "its own tab, closed after reading (the agent reads three options at once)");
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

// --- C-TGT-CART ---

test("target.cart reads the live cart page; read-back says the total with tax and the real button", { skip: !browser && "no Chromium for Playwright" }, async () => {
  const [ready, count, cart] = await run<unknown>(fixture("target-cart.html"), ["target.cartReady"], ["target.cartCount"], ["target.cart"]);
  assert.equal(ready, true);
  assert.equal(count, 1);
  const c = cart as TargetCart;
  assert.deepEqual([c.subtotal, c.tax, c.total, c.shipping, c.button], ["$20.00", "$2.05", "$28.04", "Shipping $5.99", "Sign in to check out"]);
  assert.deepEqual(c.items.map((i) => [i.tcin, i.price, i.qty]), [["94935705", "$20.00", 1]]);
  const r = targetCheckout(c);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.data.subtotal.cents, r.data.shipping?.cents, r.data.tax?.cents, r.data.total.cents], [2000, 599, 205, 2804]);
  assert.deepEqual(r.data.lines.map((l) => [l.productId, l.quantity, l.price.cents]), [["target:A-94935705", 1, 2000]]);
  assert.equal(r.data.readBack, "Your Target total is about $28.04, including $2.05 estimated tax and $5.99 shipping. Press Sign in to check out when you're ready.");
});

test("targetCheckout: an empty cart is an error, not a $0 read-back", () => {
  const r = targetCheckout({ subtotal: null, shipping: null, tax: null, total: null, items: [], button: null, empty: true, url: "https://www.target.com/cart" });
  assert.ok(!r.ok);
  assert.match(r.error.message, /empty/);
});

test("TargetFlow.addToCart: focuses the tab, picks Shipping over Pickup, clicks Add to cart via the chain, waits for the count", async () => {
  const pickupView: PageElement[] = [
    { idx: 0, role: "button", name: "Pickup Get it nearby tomorrow, selected", section: "above-the-fold-information > Fulfillment" },
    { idx: 1, role: "button", name: "Shipping Arrives by Mon, Oct 26,", section: "above-the-fold-information > Fulfillment" },
    { idx: 2, role: "button", name: "Show in-stock stores for Blanket", section: "Show in-stock stores for Blanket" },
  ];
  const shipView: PageElement[] = [
    { idx: 0, role: "button", name: "Pickup Get it nearby tomorrow,", section: "above-the-fold-information > Fulfillment" },
    { idx: 1, role: "button", name: "Shipping Arrives by Mon, Oct 26, selected", section: "above-the-fold-information > Fulfillment" },
    { idx: 2, role: "button", name: "Add to cart", section: "pageBodyContainer > above-the-fold-information" },
  ];
  let view = pickupView;
  const clicks: string[] = [];
  const focused: number[] = [];
  const waits: [string, unknown][] = [];
  const driver = {
    openTab: async () => ({ ok: true, data: { tabId: 9 } }),
    navigate: async (_t: number, url: string) => ({ ok: true, data: { url } }),
    focus: async (t: number) => void focused.push(t),
    isBlocked: async () => false,
    waitFor: async (_t: number, name: string, _ms: number, arg?: unknown) => (waits.push([name, arg]), true),
    extract: async (_t: number, name: string) => (name === "target.cartCount" ? 0 : name === "target.titlePrice" ? { title: "Sidelines Lap Blanket", price: "$20.00" } : undefined),
    snapshot: async () => ({ ok: true, data: { url: "https://www.target.com/p/-/A-94935705", title: "x", elements: view, textBlocks: [], fingerprint: "f" } }),
    act: async (_t: number, a: { idx: number }) => {
      clicks.push(view.find((e) => e.idx === a.idx)!.name);
      if (view === pickupView && a.idx === 1) view = shipView;
      return { ok: true, data: { navigated: false } };
    },
  } as unknown as FlowDriver;
  const exact: ElementPicker = {
    name: "moss",
    pick: async (state) => {
      const el = state.elements.find((e) => e.role === "button" && e.name === "Add to cart");
      return el ? { ok: true, data: { idx: el.idx, score: 1, picker: "moss", latencyMs: 1, trusted: true } } : { ok: false, error: { code: "low_confidence", message: "none", retryable: true } };
    },
  };
  const flow = new TargetFlow(driver, () => {}, undefined, { pickers: [exact] });
  const r = await flow.addToCart("target:A-94935705");
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.data, { productId: "target:A-94935705", title: "Sidelines Lap Blanket", quantity: 1, price: { cents: 2000, currency: "USD" } });
  assert.deepEqual(clicks, ["Shipping Arrives by Mon, Oct 26,", "Add to cart"]);
  assert.deepEqual(focused, [9], "Target draws the buy box only in a visible tab");
  assert.deepEqual(waits.find(([n]) => n === "target.added"), ["target.added", 0]);
});

test("NAV=amazon routes Target add to cart and checkout to target.com, not the mock", async () => {
  process.env.PICKER_CHAIN = "";
  const sent: DriverRequest[] = [];
  const cart: TargetCart = { subtotal: "$20.00", shipping: "Shipping $5.99", tax: "$2.05", total: "$28.04", items: [{ tcin: "94935705", title: "Blanket", price: "$20.00", qty: 1 }], button: "Check out", empty: false, url: "https://www.target.com/cart" };
  const driver: ExtensionDriver = new ExtensionDriver((msg: ServerMsg) => {
    if (msg.type !== "driver.request") return;
    const req = DriverRequest.parse(msg.req);
    sent.push(req);
    const data =
      req.op === "openTab" ? { tabId: 7 }
      : req.op === "navigate" ? { url: req.url }
      : req.op === "waitFor" ? { met: true }
      : req.op === "snapshot" ? { url: "https://www.target.com/p/-/A-94935705", title: "x", elements: [], textBlocks: [], fingerprint: "f" }
      : req.op === "extract" ? { value: req.name === "target.cart" ? cart : req.name === "target.cartCount" ? 0 : "" }
      : {};
    setImmediate(() => driver.handle({ type: "driver.response", id: msg.id, ok: true, data }));
  }, 500);
  const services = liveServices({ driver: () => driver });
  const added = await services.navigator.addToCart("target:A-94935705", 1, () => {});
  assert.ok(!added.ok && added.error.code !== "not_found", "reached the Target flow (no pickers here, so no trusted pick)");
  assert.ok(sent.some((q) => q.op === "navigate" && q.url === "https://www.target.com/p/-/A-94935705"));
  const r = await services.navigator.openCheckout("target", () => {});
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.data.total.cents, 2804);
  assert.equal(r.data.readBack, "Your Target total is about $28.04, including $2.05 estimated tax and $5.99 shipping. Press Check out when you're ready.");
  assert.ok(sent.some((q) => q.op === "navigate" && q.url === "https://www.target.com/cart"));
  assert.ok(!sent.some((q) => q.op === "act"), "nothing clicked on the cart page");
});
