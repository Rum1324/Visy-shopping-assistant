import type { ElementPicker, PageElement, PageState, PlanStep } from "@visy/contracts";

export type FindStep = Extract<PlanStep, { kind: "find_control" }>;

/** What gets embedded / shown to Claude for one element. `section` tells apart duplicate labels. */
export const elementDoc = (e: PageElement) => `${e.role}: ${e.name}${e.section ? ` | section: ${e.section}` : ""}`;

const TYPEABLE = new Set(["textbox", "searchbox", "combobox"]);

/** Elements a picker may choose for this step. Purchase buttons and disabled controls are never candidates. */
export function candidates(state: PageState, step: FindStep): PageElement[] {
  return state.elements.filter((e) => {
    if (e.purchaseRisk || e.disabled) return false;
    if (step.then === "type") return TYPEABLE.has(e.role);
    if (step.then === "select") return e.role === "combobox" || e.role === "listbox";
    return true;
  });
}

export const siteOf = (url: string) => new URL(url).hostname.replace(/^www\./, "");

// --- C1a: candidate prefilter (role + keyword), so Moss embeds ~30 elements instead of 150 ---

const STOP = new Set(["the", "and", "of", "to", "for", "in", "on", "or", "a", "an", "section", "this", "your", "with", "by"]);
const stem = (t: string) => t.replace(/ies$/, "y").replace(/(?<=[a-z]{3})s$/, "");
/** "averageCustomerReviews > acrPopover" → ["average", "customer", "review", "acr", "popover"] */
export const tokens = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);

const CLICKABLE = new Set(["button", "link", "menuitem", "tab", "option", "checkbox", "radio"]);
const sameFamily = (a: string, b: string) => a === b || (CLICKABLE.has(a) && CLICKABLE.has(b)) || (TYPEABLE.has(a) && TYPEABLE.has(b));

/**
 * Keeps the k most plausible candidates for a step: keyword overlap between the intent
 * ("role: name | section: …") and each element's name/section, plus role match. Remaining slots are
 * filled in viewport order, so a control whose label shares no words with the intent (Target's
 * "What can we help you find?" for "Search Target") can still be found by Moss's semantic side.
 */
export function prefilter(cands: PageElement[], step: FindStep, k: number): PageElement[] {
  if (k <= 0 || cands.length <= k) return cands;
  const m = step.intent.match(/^\s*([\w-]+)\s*:\s*([^|]*)(?:\|\s*(?:section:)?\s*(.*))?$/);
  const role = m?.[1]?.toLowerCase() ?? "";
  const nameT = new Set(tokens(m?.[2] ?? step.intent));
  const secT = new Set(tokens(m?.[3] ?? ""));
  const score = (e: PageElement) => {
    const en = tokens(e.name);
    const es = tokens(e.section ?? "");
    let s = 0;
    for (const t of en) s += nameT.has(t) ? 3 : secT.has(t) ? 1 : 0;
    for (const t of es) s += secT.has(t) ? 2 : nameT.has(t) ? 1 : 0;
    if (s > 0) s += e.role === role ? 2 : sameFamily(e.role, role) ? 1 : 0;
    return s;
  };
  const scored = cands.map((e) => ({ e, s: score(e) }));
  const hits = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.e.idx - b.e.idx).slice(0, k).map((x) => x.e);
  if (hits.length >= k) return hits;
  const chosen = new Set(hits);
  const fill = cands.filter((e) => !chosen.has(e) && sameFamily(e.role, role)).concat(cands.filter((e) => !chosen.has(e) && !sameFamily(e.role, role)));
  return hits.concat(fill.slice(0, k - hits.length));
}

/** Intent "button: Add to Cart | section: buy box" matches only role=button with name exactly "add to cart". */
export function exactIntentMatch(e: PageElement, step: FindStep) {
  const m = step.intent.match(/^\s*([\w-]+)\s*:\s*([^|]+)/);
  if (!m) return false;
  return e.role === m[1]!.toLowerCase() && e.name.trim().toLowerCase() === m[2]!.trim().toLowerCase();
}

/** Wraps a picker so it's only trusted on an exact role+name match. Used while a page is still loading. */
export const strictPicker = (p: ElementPicker): ElementPicker => ({
  name: p.name,
  pick: async (state, step) => {
    const r = await p.pick(state, step);
    if (!r.ok || !r.data.trusted) return r;
    const el = state.elements.find((e) => e.idx === r.data.idx);
    return { ok: true, data: { ...r.data, trusted: !!el && exactIntentMatch(el, step) } };
  },
});
