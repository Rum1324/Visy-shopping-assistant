import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures } from "@visy/contracts/fixtures";
import { turnMessage } from "../src/agent-tools.ts";
import { saleOf } from "../src/live.ts";
import { saleNote, withSale } from "../src/present.ts";

const usd = (cents: number) => ({ cents, currency: "USD" as const });
const priced = (cents: number, list?: number, deal?: string, requiresMembership?: string) => ({
  price: usd(cents),
  listPrice: list != null ? usd(list) : undefined,
  deal: deal ? { label: deal, requiresMembership } : undefined,
});

test("sales: a strike price above the current price is said plainly", () => {
  assert.equal(saleNote(priced(1899, 2499)), "On sale: $18.99, down from $24.99.");
});

test("sales: nothing is said without a strike price above the price or a badge", () => {
  assert.equal(saleNote(priced(1899)), undefined);
  // Amazon sometimes shows a "Typical" price equal to the current one.
  assert.equal(saleNote(priced(3099, 3099)), undefined);
  assert.equal(saleNote(priced(1899, 1500)), undefined);
  assert.equal(withSale("For the closest fit, the Blanket.", priced(1899)), "For the closest fit, the Blanket.");
});

test("sales: coupons and deal badges become one short sentence", () => {
  assert.equal(saleNote(priced(1899, undefined, "Save 20% with coupon")), "There's a 20% coupon.");
  assert.equal(saleNote(priced(1899, undefined, "Save $5.00 with coupon")), "There's a $5.00 coupon.");
  // Amazon's 2026 coupon tile, as read from the page (innerText repeats the price, then "Terms").
  assert.equal(saleNote(priced(3099, undefined, "Coupon price $28.51 $28 . 51 Terms")), "With the coupon it's $28.51.");
  assert.equal(saleNote(priced(1899, undefined, "Limited time deal")), "It's a limited time deal.");
  assert.equal(saleNote(priced(1899, undefined, "Rollback")), "Deal: Rollback.");
  assert.equal(saleNote(priced(1899, undefined, "Save 15%", "Target Circle")), "Deal: Save 15% for Target Circle members.");
  assert.equal(
    saleNote(priced(2799, 3499, "Limited time deal")),
    "On sale: $27.99, down from $34.99. It's a limited time deal.",
  );
  // A bare "Sale" badge next to a strike price is not said twice.
  assert.equal(saleNote(priced(1899, 2499, "Sale")), "On sale: $18.99, down from $24.99.");
  assert.equal(saleNote(priced(1899, undefined, "Sale")), "It's on sale.");
});

test("sales: each option's spoken line ends with the sale sentence", () => {
  const [a] = fixtures.candidates;
  assert.match(withSale("For the closest fit, the Blanket.", a!), /^For the closest fit, the Blanket\. On sale: \$27\.99, down from \$34\.99\. /);
});

test("sales: Amazon search cards keep only a strike price above the price, plus the badge text", () => {
  assert.deepEqual(saleOf({ listPrice: "$32.25", deal: null }, 2399), { listPrice: usd(3225) });
  assert.deepEqual(saleOf({ listPrice: "$28.99" }, 2899), {});
  assert.deepEqual(saleOf({ listPrice: null, deal: "Coupon price $28.51" }, 3099), {
    deal: { label: "Coupon price $28.51", requiresMembership: undefined },
  });
  assert.deepEqual(saleOf({ deal: "Prime Big Deal" }, 3099), { deal: { label: "Prime Big Deal", requiresMembership: "Prime" } });
});

test("sales: the router sees a sale field only on options that have one", () => {
  const state = fixtures.session;
  const [first, second] = state.shortlist;
  const shortlist = [
    { ...first!, product: { ...first!.product, ...priced(1899, 2499) } },
    { ...second!, product: { ...second!.product, listPrice: undefined, deal: undefined } },
  ];
  const msg = turnMessage({ ...state, shortlist }, "is any of them on sale", []);
  assert.match(msg, /"option":1,[^}]*"sale":"On sale: \$18\.99, down from \$24\.99\."/);
  assert.doesNotMatch(msg, /"option":2,[^}]*"sale"/);
});
