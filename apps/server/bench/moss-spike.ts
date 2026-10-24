/** Step 1 of the plan: is per-page Moss indexing fast enough? Measures addDocs and query for 50/150/300 fake elements. */
import { mossClient } from "../src/navigator/pickers/moss.ts";

const ROLES = ["button", "link", "textbox", "combobox", "checkbox"];
const WORDS = "add cart buy save list size color quantity search go next previous review rating deal prime ship return gift wrap compare see more details price filter brand sort featured sponsored".split(" ");
const rnd = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

const client = mossClient();
const t0 = performance.now();
const warm = await client.session("visy-spike-warm");
await warm.addDocs([{ id: "0", text: "button: warm up" }]);
await warm.query("warm", { topK: 1 });
await warm.close();
console.log(`first session (model load): ${Math.round(performance.now() - t0)} ms`);

for (const n of [50, 150, 300]) {
  const s = await client.session(`visy-spike-${n}`);
  const docs = Array.from({ length: n }, (_, i) => ({
    id: String(i),
    text: `${rnd(ROLES)}: ${rnd(WORDS)} ${rnd(WORDS)} | section: ${rnd(["buy box", "navigation", "results", "footer", "sponsored"])}`,
  }));
  docs[7] = { id: "7", text: "button: Add to Cart | section: desktop_buybox > addToCart_feature_div" };
  const a0 = performance.now();
  await s.addDocs(docs);
  const addMs = performance.now() - a0;
  const qs: number[] = [];
  let top = "";
  for (let i = 0; i < 20; i++) {
    const q0 = performance.now();
    const r = await s.query("button: Add to Cart | section: buy box", { topK: 5 });
    qs.push(performance.now() - q0);
    top = `${r.docs[0]?.id} (${r.docs[0]?.score.toFixed(3)} vs ${r.docs[1]?.score.toFixed(3)})`;
  }
  qs.sort((a, b) => a - b);
  console.log(`n=${n}: addDocs ${Math.round(addMs)} ms, query p50 ${qs[10]!.toFixed(1)} ms p95 ${qs[18]!.toFixed(1)} ms, top=${top}`);
  await s.close();
}
await client.close();
