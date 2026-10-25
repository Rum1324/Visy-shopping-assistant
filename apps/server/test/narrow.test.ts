import assert from "node:assert/strict";
import { test } from "node:test";
import { Need, type JevClient } from "@visy/contracts";
import { fixtures } from "@visy/contracts/fixtures";
import { narrowToThree } from "../src/narrow.ts";

const need = Need.parse({ query: "picnic blanket", marketplaces: ["amazon", "target", "walmart"] });
const pool = fixtures.candidates;

test("narrow: a Jev that always answers p1 still yields three different products", async () => {
  const questions: string[] = [];
  const jev: JevClient = {
    async decide({ question, options }) {
      questions.push(question);
      return { ok: true, data: { choice: options[0]!, confidence: 0.9 } };
    },
  };
  const { picks, via } = await narrowToThree(jev, need, pool);
  assert.equal(via, "jev");
  assert.equal(picks.length, 3);
  assert.equal(new Set(picks.map((p) => p.candidate.id)).size, 3);
  // Round 2 asks both repeats at once; they agree again, so the third slot comes from the heuristic.
  assert.deepEqual(picks.map((p) => p.why), ["best match", "best value", ""]);
  assert.equal(questions.length, 5, "two rounds at most");
});

test("narrow: a failing Jev falls back to the rating heuristic", async () => {
  const jev: JevClient = { decide: async () => ({ ok: false, error: { code: "internal", message: "down", retryable: true } }) };
  const { picks, via } = await narrowToThree(jev, need, pool);
  assert.equal(via, "heuristic");
  assert.equal(picks.length, 3);
});

test("narrow: the budget filters the pool, and a budget nothing meets keeps the pool", async () => {
  const cheap = await narrowToThree(null, { ...need, budget: { max: { cents: 2000, currency: "USD" } } }, pool);
  assert.ok(cheap.picks.length >= 1);
  assert.ok(cheap.picks.every((p) => p.candidate.price.cents <= 2000));
  const none = await narrowToThree(null, { ...need, budget: { max: { cents: 1, currency: "USD" } } }, pool);
  assert.equal(none.picks.length, 3);
});

test("narrow: a $100 budget reads options near $100, not the best-rated $20 ones", async () => {
  // Live run: "100 dollars is the budget" for a keyboard came back as $19.99, $22.84 and $27.03.
  const at = (id: string, cents: number, rating: number, reviewCount: number) => ({
    ...pool[0]!,
    id,
    price: { cents, currency: "USD" as const },
    rating,
    reviewCount,
  });
  const cheap = [at("c1", 1999, 4.8, 90000), at("c2", 2284, 4.7, 40000), at("c3", 2703, 4.7, 30000)];
  const near = [at("n1", 5999, 4.5, 3000), at("n2", 7999, 4.6, 8000), at("n3", 9999, 4.6, 12000)];
  const budget = { max: { cents: 10000, currency: "USD" as const } };
  const { picks } = await narrowToThree(null, { ...need, budget }, [...cheap, ...near, at("over", 14999, 4.9, 20000)]);
  assert.deepEqual(picks.map((p) => p.candidate.id).sort(), ["n1", "n2", "n3"]);
  // Fewer than three near the cap: the whole in-budget pool is still in play.
  const thin = await narrowToThree(null, { ...need, budget }, [...cheap, near[2]!]);
  assert.equal(thin.picks.length, 3);
  assert.ok(thin.picks.some((p) => p.candidate.price.cents < 5000));
  // An explicit floor ("premium") is used as given.
  const floor = await narrowToThree(null, { ...need, budget: { ...budget, min: { cents: 2800, currency: "USD" as const } } }, [...cheap, ...near]);
  assert.ok(floor.picks.every((p) => p.candidate.price.cents >= 2800));
});
