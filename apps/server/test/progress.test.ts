import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerMsg } from "@visy/contracts";
import type { AgentSink, SayKind } from "../src/agent.ts";
import { createProgress, GAP_MS, QUIET_MS } from "../src/progress.ts";

function rig() {
  let t = 0;
  const said: { text: string; kind?: SayKind }[] = [];
  const real: AgentSink = {
    send: () => {},
    say: async (text, kind) => {
      said.push({ text, kind });
    },
    stopSpeaking() {},
  };
  const p = createProgress(real, { now: () => t });
  const at = (ms: number) => {
    t = ms;
    p.tick();
  };
  const phase = (phase: string) => p.sink.send({ type: "session.snapshot", state: { phase } } as unknown as ServerMsg);
  const event = (stage: string, message: string, marketplace?: string) =>
    p.sink.send({ type: "progress", event: { stage, message, marketplace, at: "" } } as unknown as ServerMsg);
  const lines = () => said.filter((s) => s.kind === "progress").map((s) => s.text);
  return { p, said, lines, at, phase, event };
}

// Each check runs inside `during` without awaiting a timer, so only the manual ticks speak.
test("waits for 2 s of quiet and spaces lines 4.5 s apart", async () => {
  const { p, lines, at } = rig();
  await p.during(async () => {
    at(QUIET_MS - 100);
    assert.equal(lines().length, 0);
    at(QUIET_MS);
    assert.equal(lines().length, 1);
    at(QUIET_MS + GAP_MS - 100);
    assert.equal(lines().length, 1);
    at(QUIET_MS + GAP_MS);
    assert.equal(lines().length, 2);
  });
});

test("never says the same line twice in a row, and keeps lines to 6 words", async () => {
  const { p, lines, at, event, phase } = rig();
  await p.during(async () => {
    const steps = [
      () => p.tool("search"),
      () => event("searching", "Searching Amazon now", "amazon"),
      () => phase("shortlisting"),
      () => event("reading_product", "Reading the Amazon product page", "amazon"),
      () => p.tool("answer_about_product"),
      () => p.tool("add_to_cart"),
    ];
    for (let i = 0; i < 60; i++) {
      if (i % 10 === 0) steps[i / 10]!();
      at(QUIET_MS + i * GAP_MS);
    }
  });
  const said = lines();
  assert.ok(said.length > 20, said.join(" | "));
  said.forEach((line, i) => {
    assert.notEqual(line, said[i - 1], `repeat at ${i}: ${said.join(" | ")}`);
    assert.ok(line.split(/\s+/).length <= 6, line);
  });
});

test("the line matches the tool that is running", async () => {
  const cases: [string, RegExp][] = [
    ["search", /^Search/],
    ["answer_about_product", /review/i],
    ["add_to_cart", /cart/i],
    ["filter_shortlist", /compar|narrow|weigh/i],
    ["recall_usual", /usual/i],
    ["remember_preference", /sav/i],
  ];
  for (const [tool, want] of cases) {
    const { p, lines, at } = rig();
    await p.during(async () => {
      p.tool(tool);
      at(QUIET_MS);
    });
    assert.match(lines()[0] ?? "", want, tool);
  }
});

test("searching names the stores, then the others", async () => {
  const { p, lines, at, event } = rig();
  await p.during(async () => {
    for (const m of ["amazon", "target", "walmart"]) event("searching", `Searching ${m} now`, m);
    at(QUIET_MS);
    at(QUIET_MS + GAP_MS);
  });
  assert.deepEqual(lines(), ["Searching Amazon now.", "Checking Target and Walmart too."]);
});

test("a long progress message is never read out; a short one leads", async () => {
  const { p, lines, at, event } = rig();
  await p.during(async () => {
    event("reviews", "Apify found 12 external mentions (5 reddit, 7 youtube) in 3412 ms");
    at(QUIET_MS);
    event("reading_product", "Reading the Walmart product page", "walmart");
    at(QUIET_MS + GAP_MS);
  });
  assert.deepEqual(lines(), ["Reading the reviews.", "Reading the Walmart product page."]);
});

test("stops once the real answer starts, but not for the 'I'll check' line", async () => {
  const { p, lines, at, phase, said } = rig();
  await p.during(async () => {
    phase("searching");
    void p.sink.say("I'll check Amazon.", "answer");
    at(10_000);
    assert.equal(lines().length, 1);
    phase("shortlisting");
    void p.sink.say("Option one is a blanket.", "answer");
    for (let ms = 15_000; ms < 60_000; ms += 1000) at(ms);
  });
  assert.equal(lines().length, 1, said.map((s) => s.text).join(" | "));
});

test("an interrupted turn goes quiet", async () => {
  const { p, lines, at } = rig();
  await p.during(async () => {
    p.sink.stopSpeaking();
    for (let ms = 0; ms < 20_000; ms += 1000) at(ms);
  });
  assert.equal(lines().length, 0);
});

test("a bot check notice is said at once and in full, then one waiting line", async () => {
  const { p, said, lines, at, event } = rig();
  const notice = "Amazon is showing a bot check. Solve it in the browser tab I just brought up. I will not bypass it.";
  await p.during(async () => {
    event("searching", notice, "amazon");
    event("searching", notice, "amazon");
    assert.deepEqual(said, [{ text: notice, kind: "answer" }]);
    for (let ms = 0; ms < 90_000; ms += 1000) at(ms);
  });
  assert.deepEqual(lines(), ["Still waiting on the check."]);
});

test("no lines outside a turn", () => {
  const { lines, at } = rig();
  for (let ms = 0; ms < 20_000; ms += 1000) at(ms);
  assert.equal(lines().length, 0);
});
