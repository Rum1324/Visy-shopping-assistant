import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures } from "@visy/contracts/fixtures";
import { overview, pitchWriter, shortName, speakable, templateLine, type Option } from "../src/present.ts";

test("present: short names cut Amazon titles at the first comma or bar", () => {
  assert.equal(shortName("INIU Portable Charger, Slimmest 10000mAh 5V/3A Power Bank, USB C"), "INIU Portable Charger");
  assert.equal(shortName("scuddles Extra Large Picnic Blanket | 80 x 80-Inch Waterproof"), "scuddles Extra Large Picnic Blanket");
  assert.equal(shortName("1 Gallon Insulated Water Bottle for Travel: 2-in-1 Straw Spout Lid"), "1 Gallon Insulated Water Bottle");
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

  // The model gets the differences already computed.
  reply = "If you want the closest fit, the Extra Large Waterproof Picnic Blanket, $8.00 more than the best value pick at $19.99.";
  assert.equal(await line(options[0]!), reply);
  assert.match(prompt, /\$8\.00 more than the best value pick at \$19\.99/);
  assert.match(prompt, /\$2\.99 more than the most trusted pick at \$25\.00/);
  // A clean extra note after the sentence is dropped, not spoken.
  const first = reply;
  reply = `${first} Note that it is heavier than the others.`;
  assert.equal(await line(options[0]!), first);

  const selfCorrecting = [
    "If you want the closest fit, it is $2.99 more than the best value option at $25.00... wait, correction: it is $8.00 more than the best value pick at $19.99.",
    "Corrected sentence: If you want the closest fit, the Extra Large Waterproof Picnic Blanket is $8.00 more than the best value pick.",
    "If you want the closest fit, the Extra Large Waterproof Picnic Blanket, $11.11 more than the best value pick.", // wrong math
  ];
  for (const text of selfCorrecting) {
    reply = text;
    assert.equal(await line(options[0]!), templateLine(options[0]!, options), text);
  }
});
