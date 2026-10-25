import assert from "node:assert/strict";
import { test } from "node:test";
import { ok, ProductCandidate, ProductId, type ServerMsg } from "@visy/contracts";
import { mockServices } from "@visy/contracts/mocks";
import { createAgent, type AgentSink } from "../src/agent.ts";
import { isPlantSearch, nearlyNaturalQuery } from "../src/navigator/sites/nearlynatural.ts";
import { NEARLY_NATURAL, parseShopifyId, pickShops, shopifyDetail, storeName, validDomain, verifyShop, type Shop } from "../src/navigator/sites/shopify.ts";

test("only plant searches go to the fake-plant shop", () => {
  assert.equal(isPlantSearch({ query: "house plant" }), true);
  assert.equal(isPlantSearch({ query: "something green", mustHaves: ["fake plant, small"] }), true);
  assert.equal(isPlantSearch({ query: "fake succulent" }), true);
  assert.equal(isPlantSearch({ query: "picnic blanket" }), false);
  assert.equal(isPlantSearch({ query: "real house plant" }), false);
});

test("query drops words every listing there already means", () => {
  assert.equal(nearlyNaturalQuery("small green fake house plant"), "small green plant");
  assert.equal(nearlyNaturalQuery("Artificial snake plant"), "snake plant");
});

const fern = {
  id: 123,
  title: "11” Artificial Mini Fern Plant",
  handle: "11-mini-artificial-fern-plant",
  body: "<p>Soft green fronds.</p><ul><li>Height: 11 in</li></ul>",
  price: "29.99",
  compare_at_price_max: "0.00",
  available: true,
  vendor: "Nearly Natural",
  type: "Plant",
  image: "https://cdn.shopify.com/s/files/fern.jpg",
};

test("suggest.json row → detail with a shopify:<domain>:<id> id, description and https image", () => {
  const d = shopifyDetail(NEARLY_NATURAL, fern)!;
  assert.equal(d.id, "shopify:nearlynatural.com:123");
  assert.equal(ProductId.safeParse(d.id).success, true);
  assert.deepEqual(parseShopifyId(d.id), { domain: "nearlynatural.com", nativeId: "123" });
  assert.equal(d.marketplace, "shopify");
  assert.equal(storeName(d), "Nearly Natural");
  assert.equal(d.price.cents, 2999);
  assert.equal(d.listPrice, undefined);
  assert.equal(d.url, "https://nearlynatural.com/products/11-mini-artificial-fern-plant");
  assert.match(d.description, /Soft green fronds\. Height: 11 in/);
  assert.deepEqual(d.imageUrls, ["https://cdn.shopify.com/s/files/fern.jpg"]);
});

test("only public shop hostnames are fetched", () => {
  assert.equal(validDomain("fellowproducts.com"), true);
  assert.equal(validDomain("shop.example.co.uk"), true);
  for (const bad of ["localhost", "127.0.0.1", "10.0.0.1", "amazon.com", "www.walmart.com", "evil.com/path", "evil.com:8080", "printer.local", "a b.com"]) {
    assert.equal(validDomain(bad), false, bad);
  }
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const products = (rows: unknown[]) => json({ resources: { results: { products: rows } } });

test("a shop is used only when it answers suggest.json with products", async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    if (url.startsWith("https://good-kettles.test.com/")) return products([{ ...fern, title: "Gooseneck kettle" }]);
    if (url.startsWith("https://empty-kettles.test.com/")) return products([]);
    return new Response("<html>not shopify</html>", { status: 200 });
  }) as typeof fetch;
  const shop = (domain: string): Shop => ({ domain, name: domain, about: "a shop" });
  assert.equal(await verifyShop(shop("good-kettles.test.com"), "gooseneck kettle", fetcher), true);
  assert.equal(await verifyShop(shop("empty-kettles.test.com"), "gooseneck kettle", fetcher), false);
  assert.equal(await verifyShop(shop("notshopify.test.com"), "gooseneck kettle", fetcher), false);
  const before = urls.length;
  // A domain that isn't Shopify is remembered and never fetched again.
  assert.equal(await verifyShop(shop("notshopify.test.com"), "kettle", fetcher), false);
  assert.equal(urls.length, before);
  assert.match(urls[0]!, /\/search\/suggest\.json\?q=gooseneck%20kettle&resources%5Btype%5D=product/);
});

test("plant searches pick Nearly Natural without asking Claude or fetching", async () => {
  let asked = 0;
  const shops = await pickShops({ query: "small fake green plant" }, async () => (asked++, []), (async () => {
    throw new Error("no fetch");
  }) as typeof fetch);
  assert.deepEqual(shops.map((s) => s.domain), ["nearlynatural.com"]);
  assert.equal(asked, 0);
});

test("other searches use at most 2 of Claude's shops, and only ones that verify", async () => {
  const ideas = async () => [
    { domain: "dead-chalk.test.com", name: "Dead", about: "a gone shop" },
    { domain: "chalk-a.test.com", name: "Chalk A", about: "a climbing shop" },
    { domain: "chalk-b.test.com", name: "Chalk B", about: "a climbing shop" },
    { domain: "chalk-c.test.com", name: "Chalk C", about: "a climbing shop" },
  ];
  const fetcher = (async (url: string) => (url.includes("dead-chalk") ? json({}, 404) : products([{ ...fern, title: "Chalk" }]))) as typeof fetch;
  const shops = await pickShops({ query: "loose climbing chalk zz-test" }, ideas, fetcher);
  assert.deepEqual(shops.map((s) => s.name), ["Chalk A", "Chalk B"]);
});

test("agent: a picked shop is named out loud and keeps the last option slot", async () => {
  const services = mockServices({ latencyMs: 0 });
  const shop: Shop = { domain: "blankets.test.com", name: "Blanket Barn", about: "a shop that only sells blankets" };
  const detail = shopifyDetail(shop, { ...fern, id: 9, title: "Blanket Barn Picnic Blanket", handle: "picnic-blanket", price: "15.00" })!;
  const base = services.navigator;
  services.navigator = {
    ...base,
    search: async (need, m, emit) => (m === "shopify" ? ok([ProductCandidate.parse(detail)]) : base.search(need, m, emit)),
    getDetail: async (c, emit, o) => (c.id === detail.id ? ok(detail) : base.getDetail(c, emit, o)),
  };
  const said: string[] = [];
  const sent: ServerMsg[] = [];
  const sink: AgentSink = { send: (m) => sent.push(m), say: async (t) => void said.push(t), stopSpeaking() {} };
  const agent = createAgent(services, sink, { llm: null, clarify: false, shops: async () => [shop] });
  await agent.hello("demo-user");
  await agent.handleText("picnic blanket");
  assert.ok(said.includes("I'll check Amazon, Target, and Walmart, plus Blanket Barn, a shop that only sells blankets."), said.join(" | "));
  assert.equal(agent.state?.shortlist.length, 3);
  assert.equal(agent.state?.shortlist[2]?.product.id, "shopify:blankets.test.com:9");
  assert.match(agent.state?.shortlist[2]?.whyPicked ?? "", /Blanket Barn/);
});
