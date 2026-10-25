import assert from "node:assert/strict";
import { test } from "node:test";
import { amazonSearchUrl, priceRange, targetSearchUrl, walmartSearchUrl } from "../src/navigator/sites/search-urls.ts";

// Parameter names checked live on 2026-10-25 ("water bottle", $50–$2000): each results page honored them.

test("no budget: plain search URLs, as before", () => {
  assert.equal(amazonSearchUrl("water bottle"), "https://www.amazon.com/s?k=water%20bottle");
  assert.equal(walmartSearchUrl("water bottle"), "https://www.walmart.com/search?q=water%20bottle");
  assert.equal(targetSearchUrl("water bottle"), "https://www.target.com/s?searchTerm=water%20bottle");
  assert.deepEqual(priceRange({}), { minCents: undefined, maxCents: undefined });
});

test("amazon: rh=p_36 in cents, either end open", () => {
  assert.equal(amazonSearchUrl("water bottle", { minCents: 5000, maxCents: 200000 }), "https://www.amazon.com/s?k=water%20bottle&rh=p_36%3A5000-200000");
  assert.equal(amazonSearchUrl("x", { minCents: 5000 }), "https://www.amazon.com/s?k=x&rh=p_36%3A5000-");
  assert.equal(amazonSearchUrl("x", { maxCents: 2000 }), "https://www.amazon.com/s?k=x&rh=p_36%3A-2000");
});

test("walmart: whole dollars, rounded outward", () => {
  assert.equal(walmartSearchUrl("water bottle", { minCents: 5000, maxCents: 200000 }), "https://www.walmart.com/search?q=water%20bottle&min_price=50&max_price=2000");
  assert.equal(walmartSearchUrl("x", { minCents: 4999, maxCents: 1999 }), "https://www.walmart.com/search?q=x&min_price=49&max_price=20");
  assert.equal(walmartSearchUrl("x", { maxCents: 10000 }), "https://www.walmart.com/search?q=x&max_price=100");
});

test("target: the fixed price buckets that overlap the range, joined with Z", () => {
  assert.equal(
    targetSearchUrl("water bottle", { minCents: 5000, maxCents: 200000 }),
    "https://www.target.com/s?searchTerm=water%20bottle&facetedValue=5zja5Z5zja6Z5zja7Z5zja8Z5zja9Z5zjaaZ5zjabZ5zjacZ5zjad",
  );
  assert.equal(targetSearchUrl("x", { maxCents: 2000 }), "https://www.target.com/s?searchTerm=x&facetedValue=7mocuZbpbp3Zebfa1Z5zja3");
  assert.equal(targetSearchUrl("x", { minCents: 200000 }), "https://www.target.com/s?searchTerm=x&facetedValue=5zjadZ5zjae");
  // A range every bucket overlaps filters nothing, so it's left off.
  assert.equal(targetSearchUrl("x", { minCents: 0, maxCents: 1_000_000 }), "https://www.target.com/s?searchTerm=x");
});
