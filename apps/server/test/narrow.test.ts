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
