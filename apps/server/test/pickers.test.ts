import { test } from "node:test";
import assert from "node:assert/strict";
import { ok, type ElementPicker, type PageState } from "@visy/contracts";
import { candidates, elementDoc, exactIntentMatch, strictPicker } from "../src/navigator/pickers/common.ts";
import { pickWithChain } from "../src/navigator/chain.ts";

const state: PageState = {
  tabId: 1,
  url: "https://www.amazon.com/dp/B0EXAMPLE1",
  title: "Picnic Blanket",
  fingerprint: "x",
  capturedAt: new Date().toISOString(),
  textBlocks: [],
  elements: [
    { idx: 0, role: "searchbox", name: "Search Amazon", section: "navigation" },
    { idx: 1, role: "button", name: "Add to Cart", section: "desktop_buybox > addToCart_feature_div" },
    { idx: 2, role: "button", name: "Add to Cart", section: "sp-sponsored-result" },
    { idx: 3, role: "button", name: "Buy Now", section: "desktop_buybox", purchaseRisk: true },
    { idx: 4, role: "button", name: "Disabled thing", disabled: true },
  ],
};
const step = { kind: "find_control" as const, intent: "button: Buy Now", then: "click" as const };

const fake = (name: ElementPicker["name"], idx: number, trusted: boolean): ElementPicker => ({
  name,
  pick: async () => ok({ idx, score: 1, picker: name, latencyMs: 0, trusted }),
});

test("candidates never include purchase-risk or disabled elements", () => {
  const idxs = candidates(state, step).map((e) => e.idx);
  assert.deepEqual(idxs, [0, 1, 2]);
});

test("type steps only see typeable elements", () => {
  assert.deepEqual(candidates(state, { ...step, then: "type" }).map((e) => e.idx), [0]);
});

test("elementDoc includes section to tell duplicates apart", () => {
  assert.equal(elementDoc(state.elements[1]!), "button: Add to Cart | section: desktop_buybox > addToCart_feature_div");
});

test("chain falls through untrusted picks", async () => {
  const r = await pickWithChain([fake("moss", 2, false), fake("claude", 1, true)], state, step);
  assert.ok(r.ok);
  assert.equal(r.data.idx, 1);
  assert.deepEqual(r.data.tried, ["moss", "claude"]);
});

test("strict mode only trusts exact role+name matches (no keyboard-shortcut decoys)", async () => {
  const atc = { kind: "find_control" as const, intent: "button: Add to Cart | section: buy box", then: "click" as const };
  const decoy = { idx: 9, role: "button", name: "Add to cart, shift, option, K", section: "Shortcuts menu" };
  assert.equal(exactIntentMatch(state.elements[1]!, atc), true);
  assert.equal(exactIntentMatch(decoy, atc), false);
  const withDecoy = { ...state, elements: [...state.elements, decoy] };
  const r = await strictPicker(fake("moss", 9, true)).pick(withDecoy, atc);
  assert.ok(r.ok && !r.data.trusted);
});

test("chain never returns a purchase-risk element even if a picker trusts it", async () => {
  const r = await pickWithChain([fake("moss", 3, true)], state, step);
  assert.equal(r.ok, false);
});
