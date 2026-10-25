import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures } from "@visy/contracts/fixtures";
import {
  buildQueries,
  collectViaApify,
  hitsToReviews,
  prefetchApifySearch,
  resetApifyCache,
  reviewKeywords,
  reviewsFromSearchItems,
  searchPhrase,
} from "../src/intel/apify.ts";
import { citeFor, claudeReviewService, sourcesSentence } from "../src/intel/reviews.ts";
import { formatOptionBlock, formatOptionLine, formatProsConsSection, formatShortlistRoster, shortTitle } from "../src/agent.ts";

test("citeFor maps review sources to speakable labels", () => {
  assert.equal(citeFor("retailer", "amazon"), "Amazon");
  assert.equal(citeFor("reddit", "amazon"), "Reddit");
  assert.equal(citeFor("youtube", "amazon"), "YouTube");
  assert.equal(citeFor("article", "amazon"), "articles");
});

test("sourcesSentence names sources once at the end", () => {
  assert.equal(sourcesSentence({ retailer: 3 }, "amazon"), "Reviews from Amazon.");
  assert.equal(sourcesSentence({ retailer: 2, reddit: 1 }, "amazon"), "Reviews from Amazon and Reddit.");
  assert.equal(
    sourcesSentence({ retailer: 2, reddit: 1, youtube: 1, article: 1 }, "amazon"),
    "Reviews from Amazon, Reddit, YouTube, and articles.",
  );
});

test("shortTitle keeps important keywords", () => {
  assert.equal(
    shortTitle("GEARFLAG Picnic Blanket Waterproof Outdoor Blanket Extra Large (10x10) - Blue"),
    "GEARFLAG Picnic Blanket Waterproof Outdoor Blanket",
  );
});

test("option-by-option spoken layout is name/price then pros/cons", () => {
  const reviews = {
    productId: "amazon:B0EXAMPLE1" as never,
    summary: "skip",
    pros: ["Truly waterproof", "Easy to fold"],
    cons: ["Color duller than photos"],
    accessibility: [],
    sourceCounts: { retailer: 5, reddit: 2 },
    warnings: [],
    generatedAt: "2026-10-24T18:00:00Z",
  };
  assert.equal(formatOptionLine(1, "Waterproof Picnic Blanket XL", 2799), "Option 1: Waterproof Picnic Blanket XL, $27.99");
  assert.equal(
    formatShortlistRoster([
      { rank: 1, product: { title: "Waterproof Picnic Blanket", price: { cents: 2799 } } as never },
      { rank: 2, product: { title: "Sand-Proof Beach Mat", price: { cents: 1999 } } as never },
    ]),
    "Option 1: Waterproof Picnic Blanket, $27.99\nOption 2: Sand-Proof Beach Mat, $19.99",
  );
  assert.equal(
    formatProsConsSection("amazon", reviews),
    [
      "Pros:",
      "- Truly waterproof",
      "- Easy to fold",
      "Cons:",
      "- Color duller than photos",
      "Sources: Reviews from Amazon and Reddit.",
    ].join("\n"),
  );
  assert.equal(
    formatOptionBlock({
      rank: 1,
      product: { title: "Waterproof Picnic Blanket XL", price: { cents: 2799 }, marketplace: "amazon" } as never,
      reviews,
    }),
    [
      "Option 1: Waterproof Picnic Blanket XL, $27.99",
      "Pros:",
      "- Truly waterproof",
      "- Easy to fold",
      "Cons:",
      "- Color duller than photos",
      "Sources: Reviews from Amazon and Reddit.",
    ].join("\n"),
  );
});

test("searchPhrase keeps a short clean query", () => {
  assert.equal(
    searchPhrase("GEARFLAG Picnic Blanket Waterproof Outdoor Blanket Extra Large (10x10) - Blue"),
    "GEARFLAG Picnic Blanket Waterproof Outdoor Blanket Extra Large",
  );
});

test("reviewKeywords folds must-haves into the Apify phrase", () => {
  assert.match(reviewKeywords("picnic blanket", ["waterproof"]), /waterproof/i);
});

test("reviewsFromSearchItems maps SERP hits and caps per source", () => {
  const product = fixtures.details[0]!;
  const items = [
    {
      organicResults: [
        {
          title: "Waterproof picnic blanket BIFL",
          url: "https://www.reddit.com/r/BuyItForLife/comments/abc/picnic/",
          description: "Had mine two summers, backing still waterproof after washes.",
        },
        {
          title: "Amazon listing",
          url: "https://www.amazon.com/dp/B0EXAMPLE",
          description: "Should be skipped as retailer.",
        },
        {
          title: "Picnic blanket review",
          url: "https://www.youtube.com/watch?v=abc123",
          description: "Shows folding along the pre-creased lines in ten seconds.",
        },
        {
          title: "Outdoor gear roundup",
          url: "https://www.wirecutter.com/reviews/picnic-blankets/",
          description: "Editors liked the soft feel but noted the color runs dull.",
        },
      ],
    },
  ];
  const reviews = reviewsFromSearchItems(product.id, items);
  assert.equal(reviews.length, 3);
  assert.deepEqual(
    reviews.map((r) => r.source).sort(),
    ["article", "reddit", "youtube"],
  );
  assert.ok(reviews.every((r) => r.untrusted === true && r.productId === product.id));
  assert.ok(!reviews.some((r) => r.url?.includes("amazon.com")));
});

test("hitsToReviews binds prefetched hits to a product", () => {
  const reviews = hitsToReviews("amazon:B0EXAMPLE1", [
    { source: "reddit", body: "Had mine two summers, backing still waterproof after washes.", url: "https://www.reddit.com/r/x" },
  ]);
  assert.equal(reviews[0]!.productId, "amazon:B0EXAMPLE1");
  assert.equal(reviews[0]!.source, "reddit");
});

test("collectViaApify returns [] without a token", async () => {
  const prev = process.env.APIFY_TOKEN;
  delete process.env.APIFY_TOKEN;
  try {
    const out = await collectViaApify(fixtures.details[0]!, { token: "" });
    assert.deepEqual(out, []);
  } finally {
    if (prev == null) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prev;
  }
});

test("prefetchApifySearch fans out to Reddit, YouTube, and article search", async () => {
  resetApifyCache();
  const actors = new Set<string>();
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    actors.add(url);
    if (url.includes("reddit")) {
      return new Response(
        JSON.stringify([{ title: "BIFL picnic", body: "Had mine two summers, backing still waterproof after washes.", url: "https://www.reddit.com/r/x" }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("youtube")) {
      return new Response(
        JSON.stringify([{ title: "Picnic blanket review", description: "Shows folding along the pre-creased lines in ten seconds.", url: "https://www.youtube.com/watch?v=a" }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify([
        {
          organicResults: [
            {
              title: "Outdoor gear roundup",
              url: "https://www.wirecutter.com/reviews/picnic-blankets/",
              description: "Editors liked the soft feel but noted the color runs dull in sunlight.",
            },
          ],
        },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const hits = await prefetchApifySearch("picnic blanket", { token: "test-token", fetchImpl, budgetMs: 5_000 });
  assert.ok([...actors].some((u) => u.includes("reddit")));
  assert.ok([...actors].some((u) => u.includes("youtube")));
  assert.ok([...actors].some((u) => u.includes("google-search")));
  assert.deepEqual(
    hits.map((h) => h.source).sort(),
    ["article", "reddit", "youtube"],
  );
});

test("buildQueries is a single Google search for articles", () => {
  const q = buildQueries("picnic blanket");
  assert.equal(
    q,
    '"picnic blanket" review -site:amazon.com -site:walmart.com -site:target.com -site:reddit.com -site:youtube.com -site:youtu.be',
  );
  assert.doesNotMatch(q, /\n/);
});

test("collectViaApify returns [] on timeout", async () => {
  resetApifyCache();
  const fetchImpl: typeof fetch = async (_input, init) => {
    await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    throw new Error("unreachable");
  };
  const out = await collectViaApify(fixtures.details[0]!, { token: "test-token", fetchImpl, budgetMs: 30 });
  assert.deepEqual(out, []);
});

test("claudeReviewService.collectExternal is a no-op without APIFY_TOKEN", async () => {
  const prev = process.env.APIFY_TOKEN;
  delete process.env.APIFY_TOKEN;
  try {
    const events: string[] = [];
    const res = await claudeReviewService().collectExternal(fixtures.details[0]!, (e) => events.push(e.message));
    assert.ok(res.ok);
    assert.deepEqual(res.data, []);
    assert.equal(events.length, 0);
  } finally {
    if (prev == null) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prev;
  }
});
