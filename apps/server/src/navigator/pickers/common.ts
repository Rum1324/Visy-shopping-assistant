import type { PageElement, PageState, PlanStep } from "@visy/contracts";

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
