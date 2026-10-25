import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures } from "@visy/contracts/fixtures";
import {
  buildQueries,
  prefetchProductHits,
  productExternalQueries,
  productPhrase,
  modelKeys,
  hitMatchesProduct,
  collectViaApify,
  hitsToReviews,
  hitsFromReddit,
  pickRedditUrls,
  redditPostKey,
  enrichWithReddit,
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
  assert.equal(
    searchPhrase("Amazon Renewed GIGABYTE GeForce RTX 3050 WINDFORCE OC V2 6G Graphics Card"),
    "GIGABYTE GeForce RTX 3050 WINDFORCE OC V2 6G",
  );
});

test("reviewKeywords folds must-haves into the Apify phrase", () => {
  assert.match(reviewKeywords("picnic blanket", ["waterproof"]), /waterproof/i);
});

test("pickRedditUrls and hitsFromReddit deepen Google-discovered threads", () => {
  const url = "https://www.reddit.com/r/Amd/comments/abc123/sapphire_pulse_rx_9060_xt_owners/";
  assert.equal(redditPostKey(url), "abc123");
  assert.deepEqual(
    pickRedditUrls([
      { source: "reddit", url, body: "SERP snippet about the Sapphire Pulse that is long enough." },
      { source: "article", url: "https://example.com/x", body: "Not reddit." },
      { source: "reddit", url: `${url}?utm=1`, body: "Duplicate post id should be skipped here." },
    ]),
    [url.replace(/\/$/, "")],
  );
  const deep = hitsFromReddit(
    [
      { dataType: "post", url, title: "Sapphire Pulse RX 9060 XT owners", body: "Coil whine is mild after a week of 1440p gaming." },
      { dataType: "comment", url: `${url}comment/c1/`, postUrl: url, body: "Temps stay under 70C with the stock fan curve." },
      { dataType: "comment", url: `${url}comment/c2/`, postUrl: url, body: "Too short" },
    ],
    new Map([["abc123", "prod1"]]),
  );
  assert.equal(deep.length, 1);
  assert.equal(deep[0]!.source, "reddit");
  assert.match(deep[0]!.body, /Coil whine/i);
  assert.match(deep[0]!.body, /Temps stay under 70C/i);
});

test("enrichWithReddit scrapes only picked thread URLs then replaces snippets", async () => {
  resetApifyCache();
  const thread = "https://www.reddit.com/r/hardware/comments/xyz789/asus_dual_rtx_5060_review";
  let body = "";
  const fetchImpl: typeof fetch = async (_input, init) => {
    body = String(init?.body ?? "");
    return new Response(
      JSON.stringify([
        {
          dataType: "post",
          url: thread,
          title: "ASUS Dual RTX 5060 review",
          body: "Quiet dual-fan card; great for 1080p ultra with little coil whine.",
        },
        {
          dataType: "comment",
          postUrl: thread,
          body: "Agreed, runs cool in a small case with undervolt.",
        },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const existing = new Map([
    [
      "asus",
      [
        {
          source: "reddit" as const,
          url: thread,
          body: "ASUS Dual RTX 5060 review - short Google snippet only about the listing.",
        },
      ],
    ],
  ]);
  const out = await enrichWithReddit([{ id: "asus", title: "ASUS Dual GeForce RTX 5060 OC", brand: "ASUS" }], existing, {
    token: "test-token",
    fetchImpl,
    budgetMs: 5_000,
  });
  const input = JSON.parse(body) as { startUrls: { url: string }[]; maxComments: number };
  assert.deepEqual(input.startUrls, [{ url: thread }]);
  assert.equal(input.maxComments, 25);
  assert.match(out.get("asus")?.[0]?.body ?? "", /Quiet dual-fan/i);
  assert.match(out.get("asus")?.[0]?.body ?? "", /undervolt/i);
});

test("modelKeys and hitMatchesProduct keep the exact GPU / SKU, not sibling models", () => {
  const title = "ZOTAC Gaming GeForce RTX 5060 Ti 16GB Twin Edge OC";
  assert.ok(modelKeys(title).some((k) => /5060\s*ti/i.test(k)));
  assert.equal(productPhrase(title), "ZOTAC rtx 5060 ti");
  assert.ok(
    hitMatchesProduct("Zotac RTX 5060 Ti twin edge is loud but cool", title),
    "same model should match",
  );
  assert.equal(
    hitMatchesProduct("Zotac RTX 4070 Ti is a better deal this week", title),
    false,
    "sibling GPU must not match",
  );
  const dual = "ASUS Dual GeForce RTX 5060 OC Edition White";
  assert.equal(productPhrase(dual, "ASUS"), "ASUS rtx 5060");
  assert.equal(
    hitMatchesProduct("ASUS Dual RTX 5060 Ti is a different card", dual, "ASUS"),
    false,
    "Ti must not match non-Ti",
  );
  assert.ok(hitMatchesProduct("ASUS Dual GeForce RTX 5060 runs cool at 1080p", dual, "ASUS"));
  // Quote the model key only so "ASUS Dual … RTX 5060" titles still rank.
  assert.deepEqual(
    productExternalQueries(productPhrase(title), "rtx 5060 ti")[0],
    'ZOTAC "rtx 5060 ti" review site:reddit.com',
  );
  assert.deepEqual(
    productExternalQueries(productPhrase(dual, "ASUS"), "rtx 5060")[0],
    'ASUS "rtx 5060" review site:reddit.com',
  );
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

test("prefetchApifySearch gets articles and Reddit from one Google run", async () => {
  resetApifyCache();
  const actors = new Set<string>();
  let serpBody = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    actors.add(String(input));
    serpBody = String(init?.body ?? "");
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
        {
          organicResults: [
            {
              title: "BIFL picnic blanket?",
              url: "https://www.reddit.com/r/BuyItForLife/comments/abc/picnic/",
              description: "Had mine two summers, backing still waterproof after washes.",
            },
          ],
        },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const hits = await prefetchApifySearch("picnic blanket", { token: "test-token", fetchImpl, budgetMs: 5_000 });
  // The Reddit and YouTube actors were too slow live; only the Google actor runs.
  assert.deepEqual([...actors].map((u) => new URL(u).pathname.split("/")[3]), ["apify~google-search-scraper"]);
  const queries = String(JSON.parse(serpBody).queries).split("\n");
  assert.deepEqual(queries, [buildQueries("picnic blanket"), "picnic blanket site:reddit.com"]);
  assert.deepEqual(hits.map((h) => h.source).sort(), ["article", "reddit"]);
});

test("prefetchProductHits scrapes Reddit, YouTube, and articles per shortlist product", async () => {
  resetApifyCache();
  let googleQueries: string[] = [];
  const page = (term: string, results: { title: string; url: string; description: string }[]) => ({ searchQuery: { term }, organicResults: results });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("youtube")) {
      return new Response(
        JSON.stringify([
          {
            title: "Sony WH-1000XM5 long term review",
            description: "Sony WH-1000XM5 still blocks plane noise well after two years of daily use.",
            url: "https://www.youtube.com/watch?v=abc",
            transcript: "The Sony WH-1000XM5 ear pads stayed soft; clamping force is firm for long flights.",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    googleQueries = String(JSON.parse(String(init?.body)).queries).split("\n");
    const sonyPhrase = productPhrase("Sony WH-1000XM5 Wireless Noise Canceling Headphones, 30 Hour Battery");
    const ankerPhrase = productPhrase("Space One Active Noise Cancelling Headphones", "Soundcore");
    const sonyReddit = productExternalQueries(sonyPhrase, "wh-1000xm5")[0]!;
    const ankerArticle = productExternalQueries(ankerPhrase)[2]!;
    return new Response(
      JSON.stringify([
        page(ankerArticle, [
          { title: "Soundcore Space One review", url: "https://www.soundguys.com/space-one", description: "Soundcore Space One battery lasted 40 hours with ANC on in our test." },
          { title: "Best headphones of the year", url: "https://www.example.com/best", description: "Our favorite over-ear picks for travel and the office." },
          { title: "Soundcore Q30 review", url: "https://www.soundguys.com/q30", description: "Soundcore Q30 is a different model and should be dropped." },
        ]),
        page(sonyReddit, [
          { title: "Wh-1000XM5 review after 2 years", url: "https://www.reddit.com/r/sony/comments/x", description: "Sony WH-1000XM5 headband cracked after a year, sound still great." },
          { title: "Sony WH-1000XM4 review", url: "https://www.reddit.com/r/sony/comments/y", description: "The older XM4 still holds up; not about the XM5." },
          { title: "Sony WH-1000XM5 Review", url: "https://www.amazon.com/dp/B09", description: "Sony WH-1000XM5 on Amazon with free shipping today." },
        ]),
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const out = await prefetchProductHits(
    [
      { id: "sony", title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones, 30 Hour Battery" },
      { id: "anker", title: "Space One Active Noise Cancelling Headphones", brand: "Soundcore" },
    ],
    { token: "test-token", fetchImpl, budgetMs: 5_000 },
  );
  assert.equal(googleQueries.length, 6);
  assert.ok(googleQueries.every((q) => q.includes('"')));
  assert.ok(googleQueries.some((q) => /site:reddit\.com/.test(q)));
  assert.ok(googleQueries.some((q) => /site:youtube\.com/.test(q)));
  // Retailer pages and sibling SKUs are dropped; YouTube actor adds a transcript snippet for Sony.
  assert.ok(out.get("sony")?.some((h) => h.source === "reddit" && /WH-1000XM5/i.test(h.body)));
  assert.ok(!out.get("sony")?.some((h) => /XM4/i.test(h.body)));
  assert.ok(out.get("sony")?.some((h) => h.source === "youtube" && /ear pads/i.test(h.body)));
  assert.deepEqual(out.get("anker")?.map((h) => h.url), ["https://www.soundguys.com/space-one"]);
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
