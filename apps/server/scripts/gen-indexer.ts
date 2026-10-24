import { writeFileSync } from "node:fs";
import { extensionIndexerSource } from "../src/navigator/driver/indexer.ts";

const out = new URL("../../extension/indexer.js", import.meta.url);
writeFileSync(out, extensionIndexerSource());
console.log("wrote", out.pathname);
