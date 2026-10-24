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
