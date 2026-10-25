import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures } from "@visy/contracts/fixtures";
import { cleanListingTitle, overview, pitchWriter, shortName, speakable, templateLine, type Option } from "../src/present.ts";

test("cleanListingTitle drops Amazon Renewed / Sponsored badges", () => {
  assert.equal(
    cleanListingTitle("Amazon Renewed GIGABYTE GeForce RTX 3050 WINDFORCE OC V2 6G"),
    "GIGABYTE GeForce RTX 3050 WINDFORCE OC V2 6G",
  );
  assert.equal(shortName("Amazon Renewed GIGABYTE GeForce RTX 3050 WINDFORCE OC V2 6G"), "GIGABYTE GeForce RTX 3050 WINDFORCE OC");
  assert.equal(shortName("Sponsored Amazon Renewed ASUS Dual GeForce RTX 3050"), "ASUS Dual GeForce RTX 3050");
});

test("present: short names cut Amazon titles at the first comma or bar", () => {
  assert.equal(shortName("INIU Portable Charger, Slimmest 10000mAh 5V/3A Power Bank, USB C"), "INIU Portable Charger");
  assert.equal(shortName("scuddles Extra Large Picnic Blanket | 80 x 80-Inch Waterproof"), "scuddles Extra Large Picnic Blanket");
  assert.equal(shortName("1 Gallon Insulated Water Bottle for Travel: 2-in-1 Straw Spout Lid"), "1 Gallon Insulated Water Bottle");
});

test("present: the overview is one short sentence per option, and the option lines don't repeat prices", () => {
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
  // UX-LEN: the overview already read every price, so the per-option lines stay short and price-free.
  for (const o of options) {
    const line = templateLine(o, options);
    assert.doesNotMatch(line, /\$\d/, line);
    assert.ok(line.split(/\s+/).length <= 30, line);
  }
});

test("present: all-caps brand names are spoken as words, short acronyms stay", () => {
  assert.equal(speakable("POWCAN Portable Charger with USB-C and LED, by YETI. HDMI cable"), "Powcan Portable Charger with USB-C and LED, by Yeti. HDMI cable");
  assert.equal(speakable("IPX7 rated, 20000mAh"), "IPX7 rated, 20000mAh");
});

test("present: a self-correcting or miscounted pitch falls back to the template line", async () => {
  const [a, b, c] = fixtures.candidates; // $27.99, $19.99, $25.00
  const options: Option[] = [
    { rank: 1, why: "best match", product: a! },
    { rank: 2, why: "best value", product: b! },
    { rank: 3, why: "most trusted by buyers", product: c! },
  ];
  let reply = "";
  let prompt = "";
  const client = {
    messages: {
      create: async (req: any) => {
        prompt = req.messages[0].content;
        return { content: [{ type: "text", text: reply }] };
      },
    },
  };
  const pitch = pitchWriter(client as any, "test-model");
  const line = async (o: Option) => (await pitch(fixtures.need, o, options)) ?? templateLine(o, options);

  // A short line is spoken as is. The model isn't handed price comparisons any more (UX-LEN: prices were just read).
  reply = "If you want the closest fit, the Extra Large Waterproof Picnic Blanket folds into its own bag.";
  assert.equal(await line(options[0]!), reply);
  assert.doesNotMatch(prompt, /more than the|priceComparison/);
  // A clean extra note after the sentence is dropped, not spoken.
  const first = reply;
  reply = `${first} Note that it is heavier than the others.`;
  assert.equal(await line(options[0]!), first);

  const selfCorrecting = [
    "If you want the closest fit, it is $2.99 more than the best value option at $25.00... wait, correction: it is $8.00 more than the best value pick at $19.99.",
    "Corrected sentence: If you want the closest fit, the Extra Large Waterproof Picnic Blanket is $8.00 more than the best value pick.",
    "If you want the closest fit, the Extra Large Waterproof Picnic Blanket, $11.11 more than the best value pick.", // wrong math
    // Live run (water bottles): a long line that also compared the pick with itself.
    "If you want a big bottle for long days out, try the Extra Large Waterproof Picnic Blanket, a best match pick that keeps you dry, priced at $27.99, the same as the best match pick.",
  ];
  for (const text of selfCorrecting) {
    reply = text;
    assert.equal(await line(options[0]!), templateLine(options[0]!, options), text);
  }
});
