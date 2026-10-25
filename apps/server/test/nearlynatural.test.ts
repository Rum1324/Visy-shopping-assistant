import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlantSearch, nearlyNaturalDetail, nearlyNaturalQuery } from "../src/navigator/sites/nearlynatural.ts";

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

test("suggest.json row → detail with description and https image", () => {
  const d = nearlyNaturalDetail({
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
  })!;
  assert.equal(d.id, "nearlynatural:123");
  assert.equal(d.marketplace, "nearlynatural");
  assert.equal(d.price.cents, 2999);
  assert.equal(d.listPrice, undefined);
  assert.equal(d.url, "https://nearlynatural.com/products/11-mini-artificial-fern-plant");
  assert.match(d.description, /Soft green fronds\. Height: 11 in/);
  assert.deepEqual(d.imageUrls, ["https://cdn.shopify.com/s/files/fern.jpg"]);
});
