/**
 * D1/D3 smoke test on fixtures: synthesis (incl. the prompt-injection review) and, with an image URL, vision.
 *   npm run intel -w @visy/server
 *   npm run intel -w @visy/server -- https://m.media-amazon.com/images/I/....jpg   # also describe a real photo
 *   npm run intel -w @visy/server -- --amazon "picnic blanket"   # real search + C2 reviews, then synthesis, Moss Q&A, vision
 */
import { fixtures } from "@visy/contracts/fixtures";
import { claudeReviewService } from "../src/intel/reviews.ts";
import { claudeVisionService } from "../src/intel/vision.ts";
import { INTEL_EFFORT, INTEL_MODEL } from "../src/intel/claude.ts";
import { mossReviewIndex } from "../src/intel/review-index.ts";
import { liveServices } from "../src/live.ts";
import { Need } from "@visy/contracts";

if (process.argv.includes("--amazon")) {
  const query = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "picnic blanket";
  const nav = liveServices().navigator;
  const emit = (e: { message: string }) => console.log(`  · ${e.message}`);
  const need = Need.parse({ query, marketplaces: ["amazon"] });
  const index = mossReviewIndex();
  const warm = index.warm();
  const found = await nav.search(need, "amazon", emit);
  if (!found.ok) throw new Error(`search: ${found.error.message}`);
  let t = performance.now();
  const detail = await nav.getDetail(found.data[0]!, emit);
  if (!detail.ok) throw new Error(`getDetail: ${detail.error.message}`);
  const d = detail.data;
  console.log(`\n${d.id} ${d.title.slice(0, 80)}\n  ${d.retailerReviews.length} retailer reviews, image ${d.imageUrls[0] ?? "none"}, getDetail ${Math.round(performance.now() - t)} ms`);
  t = performance.now();
  const reviews = claudeReviewService();
  const external = await reviews.collectExternal(d, emit);
  console.log(`  collectExternal: ${external.ok ? external.data.length : external.error.message} in ${Math.round(performance.now() - t)} ms`);
  const pool = [...d.retailerReviews, ...(external.ok ? external.data : [])];
  t = performance.now();
  const [s, v] = await Promise.all([reviews.synthesize(d, pool, need), claudeVisionService().describe(d)]);
  console.log(`  synthesis + vision in parallel: ${Math.round(performance.now() - t)} ms`);
  if (s.ok) {
    console.log(`  sources: ${JSON.stringify(s.data.sourceCounts)}`);
    console.log(`  ${s.data.summary}\n  pros: ${s.data.pros.join("; ")}\n  cons: ${s.data.cons.join("; ")}\n  warnings: ${s.data.warnings.join(" | ")}`);
    for (const a of s.data.accessibility) console.log(`  [${a.sentiment} ×${a.evidenceCount}] ${a.answer}`);
  } else console.log(`  synthesis ERROR ${s.error.code} ${s.error.message}`);
  console.log(v.ok ? `  vision: ${v.data.short} (${v.data.confidence})` : `  vision ERROR ${v.error.message}`);
  await warm;
  t = performance.now();
  const ix = await index.index(d.id, pool);
  console.log(`  moss index: ${ix.ok ? ix.data.chunks : ix.error.message} chunks, ${Math.round(performance.now() - t)} ms`);
  for (const q of ["is it easy to fold up by feel?", "does the color match the photos?", "is it really waterproof?"]) {
    t = performance.now();
    const hit = await index.search(d.id, q, 1);
    const top = hit.ok ? hit.data[0] : undefined;
    console.log(`  Q ${q} (${Math.round(performance.now() - t)} ms)\n    → ${top ? JSON.stringify(`${top.title ?? ""}. ${top.body}`.slice(0, 160)) : "none"}`);
  }
  process.exit(0);
}

console.log(`model ${INTEL_MODEL} effort ${INTEL_EFFORT}`);
const reviews = claudeReviewService();
for (const d of fixtures.details) {
  const pool = [...d.retailerReviews, ...fixtures.externalReviews.filter((r) => r.productId === d.id)];
  const t0 = performance.now();
  const s = await reviews.synthesize(d, pool, fixtures.need);
  const ms = Math.round(performance.now() - t0);
  if (!s.ok) {
    console.log(`${d.id}: ERROR ${s.error.code} ${s.error.message}`);
    continue;
  }
  console.log(`\n${d.id} (${pool.length} reviews, ${ms} ms)\n  ${s.data.summary}\n  pros: ${s.data.pros.join("; ")}\n  cons: ${s.data.cons.join("; ")}\n  warnings: ${s.data.warnings.join(" | ")}`);
  for (const a of s.data.accessibility.filter((a) => a.sentiment !== "unknown")) console.log(`  [${a.sentiment}] ${a.answer}`);
}
const url = process.argv[2];
if (url) {
  const t0 = performance.now();
  const v = await claudeVisionService().describe({ ...fixtures.details[0]!, imageUrls: [url] });
  console.log(`\nvision (${Math.round(performance.now() - t0)} ms):`, v.ok ? v.data : v.error);
}
