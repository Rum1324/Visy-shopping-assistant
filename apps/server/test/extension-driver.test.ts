import { test } from "node:test";
import assert from "node:assert/strict";
import type { DriverRequest, PageState, ServerMsg } from "@visy/contracts";
import { ExtensionDriver } from "../src/navigator/driver/extension.ts";

const page = (over: Partial<PageState> = {}): PageState => ({
  tabId: 7,
  url: "https://www.amazon.com/dp/B0EXAMPLE1",
  title: "Picnic Blanket",
  fingerprint: "f",
  capturedAt: new Date().toISOString(),
  textBlocks: [],
  elements: [
    { idx: 0, role: "button", name: "Add to Cart", section: "buy box" },
    { idx: 1, role: "button", name: "Buy Now", section: "buy box", purchaseRisk: true },
  ],
  ...over,
});

/** A fake extension that answers each request with whatever `reply` returns. */
function wire(reply: (req: DriverRequest) => { ok: boolean; data?: unknown } | undefined) {
  const sent: DriverRequest[] = [];
  const driver: ExtensionDriver = new ExtensionDriver((msg: ServerMsg) => {
    if (msg.type !== "driver.request") return;
    sent.push(msg.req);
    const r = reply(msg.req);
    if (r) setImmediate(() => driver.handle({ type: "driver.response", id: msg.id, ...r }));
  }, 200);
  return { driver, sent };
}

test("round-trips and validates payloads", async () => {
  const { driver } = wire((req) => (req.op === "openTab" ? { ok: true, data: { tabId: 7 } } : { ok: true, data: page() }));
  const t = await driver.openTab("https://www.amazon.com/");
  assert.deepEqual(t, { ok: true, data: { tabId: 7 } });
  const s = await driver.snapshot(7);
  assert.ok(s.ok && s.data.elements.length === 2);
});

test("malformed payload becomes parse_failed, not a crash", async () => {
  const { driver } = wire(() => ({ ok: true, data: { tabId: "seven" } }));
  const t = await driver.openTab("https://www.amazon.com/");
  assert.ok(!t.ok && t.error.code === "parse_failed");
});

test("no answer times out", async () => {
  const { driver } = wire(() => undefined);
  const r = await driver.screenshot(7);
  assert.ok(!r.ok && r.error.code === "timeout");
});

test("purchase buttons are refused before anything is sent", async () => {
  const { driver, sent } = wire(() => ({ ok: true, data: page() }));
  await driver.snapshot(7);
  const r = await driver.act(7, { kind: "click", idx: 1 });
  assert.ok(!r.ok && r.error.code === "forbidden_action");
  assert.equal(sent.filter((q) => q.op === "act").length, 0);
});

test("bot-check pages come back as blocked", async () => {
  const { driver } = wire(() => ({ ok: true, data: page({ url: "https://www.amazon.com/checkpoint/continue?token=x" }) }));
  const s = await driver.snapshot(7);
  assert.ok(!s.ok && s.error.code === "blocked");
});

test("dispose fails in-flight calls", async () => {
  const { driver } = wire(() => undefined);
  const p = driver.navigate(7, "https://www.amazon.com/");
  driver.dispose();
  const r = await p;
  assert.ok(!r.ok && r.error.code === "internal");
});

test("extract sends a script name and argument, never JS, and returns the value", async () => {
  const { driver, sent } = wire((req) => (req.op === "extract" ? { ok: true, data: { value: [{ asin: "B0X" }] } } : undefined));
  const v = await driver.extract<{ asin: string }[]>(7, "amazon.reviewsGrew", 10);
  assert.deepEqual(v, [{ asin: "B0X" }]);
  assert.deepEqual(sent[0], { op: "extract", tabId: 7, name: "amazon.reviewsGrew", arg: 10 });
});

test("extract throws when the extension can't run the script, like page.evaluate", async () => {
  const { driver } = wire(() => ({ ok: false }));
  await assert.rejects(driver.extract(7, "href"), /extract href/);
});

test("waitFor passes its timeout to the extension and reads met", async () => {
  const { driver, sent } = wire((req) => (req.op === "waitFor" ? { ok: true, data: { met: req.name === "loaded" } } : undefined));
  assert.equal(await driver.waitFor(7, "loaded", 5000), true);
  assert.equal(await driver.waitFor(7, "amazon.added", 5000, "https://www.amazon.com/dp/B0X"), false);
  assert.deepEqual(sent[1], { op: "waitFor", tabId: 7, name: "amazon.added", timeoutMs: 5000, arg: "https://www.amazon.com/dp/B0X" });
});

test("waitFor that never answers is false, not a throw", async () => {
  const { driver } = wire(() => undefined);
  assert.equal(await driver.waitFor(7, "loaded", 1), false);
});

test("openTab in the background, focus, and the bot-check probe", async () => {
  const { driver, sent } = wire((req) =>
    req.op === "openTab"
      ? { ok: true, data: { tabId: 9 } }
      : req.op === "extract"
        ? { ok: true, data: { value: "https://www.amazon.com/errors/validateCaptcha Robot Check" } }
        : { ok: true, data: {} },
  );
  assert.deepEqual(await driver.openTab("about:blank", { background: true }), { ok: true, data: { tabId: 9 } });
  await driver.focus(9);
  assert.equal(await driver.isBlocked(9), true);
  assert.deepEqual(
    sent.map((q) => q.op),
    ["openTab", "focus", "extract"],
  );
  assert.equal((sent[0] as { background?: boolean }).background, true);
  assert.equal((sent[2] as { name: string }).name, "blockProbe");
});
