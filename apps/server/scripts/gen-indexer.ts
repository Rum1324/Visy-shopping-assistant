import { writeFileSync } from "node:fs";
import { extensionIndexerSource } from "../src/navigator/driver/indexer.ts";
import { extensionScriptsSource } from "../src/navigator/scripts.ts";

for (const [file, src] of [
  ["indexer.js", extensionIndexerSource()],
  ["scripts.js", extensionScriptsSource()],
]) {
  const out = new URL(`../../extension/${file}`, import.meta.url);
  writeFileSync(out, src);
  console.log("wrote", out.pathname);
}
