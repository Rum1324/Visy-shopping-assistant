import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DriverRequest, type ServerMsg } from "@visy/contracts";
import { ExtensionDriver } from "../src/navigator/driver/extension.ts";
import { liveServices } from "../src/live.ts";
import { extensionScriptsSource, PAGE_SCRIPTS } from "../src/navigator/scripts.ts";

test("extension scripts.js is generated from PAGE_SCRIPTS", () => {
  const ext = readFileSync(new URL("../../extension/scripts.js", import.meta.url), "utf8");
  assert.equal(ext, extensionScriptsSource(), "run `npm run gen-indexer -w @visy/server`");
});

test("every page script is a valid JS expression over arg", () => {
  for (const [name, js] of Object.entries(PAGE_SCRIPTS)) {
    assert.doesNotThrow(() => new Function("arg", `return (${js});`), name);
  }
});

test("NAV=amazon search runs in the connected extension's Chrome, in a background tab", async () => {
  process.env.PICKER_CHAIN = "";
  const sent: DriverRequest[] = [];
  const rows = [
    { asin: "B0SPONSOR1", title: "Sponsored blanket", price: "$9.99", rating: "4.0 out of 5 stars", sponsored: true },
    { asin: "B0ORGANIC1", title: "Picnic Blanket, Waterproof", price: "$24.99", rating: "4.6 out of 5 stars", sponsored: false },
  ];
  const driver: ExtensionDriver = new ExtensionDriver((msg: ServerMsg) => {
    if (msg.type !== "driver.request") return;
    const req = DriverRequest.parse(msg.req);
    sent.push(req);
    const data =
      req.op === "openTab" ? { tabId: 41 }
      : req.op === "navigate" ? { url: req.url }
      : req.op === "waitFor" ? { met: true }
      : req.op === "extract" ? { value: req.name === "amazon.results" ? rows : "https://www.amazon.com/s?k=picnic+blanket Amazon.com" }
      : {};
    setImmediate(() => driver.handle({ type: "driver.response", id: msg.id, ok: true, data }));
  }, 500);
  const services = liveServices({ driver: () => driver });
  const r = await services.navigator.search({ query: "picnic blanket" } as never, "amazon", () => {});
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.data.map((c) => c.id), ["amazon:B0ORGANIC1"]);
  assert.deepEqual(sent[0], { op: "openTab", url: "about:blank", background: true });
  assert.ok(sent.some((q) => q.op === "navigate" && q.url === "https://www.amazon.com/s?k=picnic%20blanket"));
  assert.ok(sent.every((q) => q.op !== "extract" || q.name in PAGE_SCRIPTS));
});
