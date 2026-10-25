import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures } from "@visy/contracts/fixtures";
import { overview, shortName, templateLine, type Option } from "../src/present.ts";

test("present: short names cut Amazon titles at the first comma or bar", () => {
  assert.equal(shortName("INIU Portable Charger, Slimmest 10000mAh 5V/3A Power Bank, USB C"), "INIU Portable Charger");
  assert.equal(shortName("scuddles Extra Large Picnic Blanket | 80 x 80-Inch Waterproof"), "scuddles Extra Large Picnic Blanket");
});

test("present: the overview is one short sentence per option, and each line compares price", () => {
  const [a, b, c] = fixtures.candidates;
  const options: Option[] = [
    { rank: 1, why: "best match", product: a! },
    { rank: 2, why: "best value", product: b! },
    { rank: 3, why: "most trusted by buyers", product: c! },
  ];
  const text = overview(options);
  assert.match(text, /^Best match: .+, \$\d+\.\d{2}\. Best value: .+ Most trusted: .+\.$/);
  assert.ok(text.split(" ").length < 45);
  assert.match(templateLine(options[1]!, options), /^If you want to spend less/);
  assert.match(templateLine(options[0]!, options), /more than the cheapest|cheapest of the three/);
});
