import { describe, expect, it } from "vitest";
import { Action, ClientMsg, CONTRACT_VERSION, ServerMsg, ShortlistItem } from "../src/index.ts";
import { fixtures } from "../src/fixtures.ts";
import { fixtureDriver, mockServices, noopEmit } from "../src/mocks.ts";

describe("fixtures", () => {
  it("parse on import and cover the demo scenario", () => {
    expect(fixtures.candidates.map((c) => c.marketplace)).toEqual(expect.arrayContaining(["amazon", "target", "walmart"]));
    expect(fixtures.shortlist).toHaveLength(3);
  });
});

describe("wire protocol", () => {
  it("accepts every message type the mock server and extension exchange", () => {
    const client = [
      { type: "hello", protocol: CONTRACT_VERSION, userId: "demo-user", client: "extension" },
      { type: "user.text", text: "I need a picnic blanket" },
      { type: "driver.response", id: "d1", ok: true, data: fixtures.pageState },
      { type: "checkout.confirm", total: fixtures.checkout.total },
    ];
    const server = [
      { type: "welcome", sessionId: "s1", protocol: CONTRACT_VERSION },
      { type: "session.snapshot", state: fixtures.session },
      { type: "driver.request", id: "d1", req: { op: "snapshot", tabId: 101 } },
      { type: "checkout.confirmRequired", review: fixtures.checkout },
      { type: "settings.changed", speechRate: 1.4 },
      { type: "settings.changed", micMuted: true },
    ];
    for (const m of client) expect(ClientMsg.safeParse(m).success).toBe(true);
    for (const m of server) expect(ServerMsg.safeParse(m).success).toBe(true);
  });

  it("has no action that can submit an order", () => {
    expect(Action.safeParse({ kind: "submit_order" }).success).toBe(false);
  });
});

describe("mock services", () => {
  it("run the full search → shortlist flow", async () => {
    const s = mockServices({ latencyMs: 0 });
    const results = await Promise.all(fixtures.need.marketplaces.map((m) => s.navigator.search(fixtures.need, m, noopEmit)));
    const candidates = results.flatMap((r) => (r.ok ? r.data : []));
    expect(candidates.length).toBeGreaterThanOrEqual(3);

    const detail = await s.navigator.getDetail(candidates[0]!, noopEmit);
    if (!detail.ok) throw new Error(detail.error.message);
    const [ext, visual] = await Promise.all([s.reviews.collectExternal(detail.data, noopEmit), s.vision.describe(detail.data)]);
    const reviews = [...detail.data.retailerReviews, ...(ext.ok ? ext.data : [])];
    const synthesis = await s.reviews.synthesize(detail.data, reviews, fixtures.need);
    const item = ShortlistItem.parse({
      rank: 1,
      product: detail.data,
      reviews: synthesis.ok ? synthesis.data : undefined,
      visual: visual.ok ? visual.data : undefined,
      whyPicked: "test",
    });
    expect(item.reviews?.accessibility.length).toBeGreaterThan(0);

    await s.reviewIndex.index(detail.data.id, reviews);
    const hits = await s.reviewIndex.search(detail.data.id, "is it waterproof after washing?");
    expect(hits.ok && hits.data.length).toBeTruthy();
  });

  it("fixture driver refuses purchase buttons", async () => {
    const res = await fixtureDriver().act(101, { kind: "click", idx: 5 });
    expect(res.ok).toBe(false);
  });
});
