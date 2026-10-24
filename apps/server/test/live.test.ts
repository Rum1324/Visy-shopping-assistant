import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDollars } from "../src/live.ts";

test("parseDollars reads Amazon price strings as cents", () => {
  assert.equal(parseDollars("$12.99"), 1299);
  assert.equal(parseDollars("$1,234.50"), 123450);
  assert.equal(parseDollars("$8"), 800);
  assert.equal(parseDollars("$8.5"), 850);
  assert.equal(parseDollars(null), undefined);
  assert.equal(parseDollars("free"), undefined);
});
