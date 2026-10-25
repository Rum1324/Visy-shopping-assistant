import { CAPTCHA_PROBE_JS } from "./driver/blocked.ts";
import { RECIPE_SCRIPTS } from "./recipes.ts";
import { AMAZON_SCRIPTS } from "./sites/amazon.ts";
import { TARGET_SCRIPTS } from "./sites/target.ts";

/**
 * Named in-page scripts. Each is a JS expression over `arg` (one JSON value, null when not given).
 * PlaywrightDriver evaluates the string. The extension can't eval strings (MV3), so `npm run gen-indexer`
 * writes them into apps/extension/scripts.js as real functions and the server only sends the name.
 * Whatever they return is page data: UNTRUSTED.
 */
export const PAGE_SCRIPTS = {
  readyState: `document.readyState`,
  href: `location.href`,
  loaded: `document.readyState !== 'loading'`,
  complete: `document.readyState === 'complete'`,
  blockProbe: CAPTCHA_PROBE_JS,
  ...AMAZON_SCRIPTS,
  ...TARGET_SCRIPTS,
  ...RECIPE_SCRIPTS,
} satisfies Record<string, string>;

export type ScriptName = keyof typeof PAGE_SCRIPTS;

/** For page.evaluate / waitForFunction. */
export const scriptCall = (name: ScriptName, arg: unknown = null) => `((arg) => (${PAGE_SCRIPTS[name]}))(${JSON.stringify(arg ?? null)})`;

export function extensionScriptsSource() {
  const body = Object.entries(PAGE_SCRIPTS)
    .map(([name, js]) => `  ${JSON.stringify(name)}: (arg) => (${js}),`)
    .join("\n");
  return `// GENERATED from apps/server/src/navigator/scripts.ts by \`npm run gen-indexer -w @visy/server\`. Do not edit.\nexport const SCRIPTS = {\n${body}\n};\n`;
}
