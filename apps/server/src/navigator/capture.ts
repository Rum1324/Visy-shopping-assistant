/**
 * Track C5: capture the user's open tab as a PageState, for "what's on this page?" (Track D answers it).
 * The PageState's textBlocks and element names are page text: UNTRUSTED data, never instructions.
 */
import { ACTIVE_TAB, type BrowserDriver, type PageState, type Result } from "@visy/contracts";

export type CapturePage = (opts?: { tabId?: number; maxElements?: number }) => Promise<Result<PageState>>;

export function pageCapture(driver: BrowserDriver): CapturePage {
  return ({ tabId = ACTIVE_TAB, maxElements = 200 } = {}) => driver.snapshot(tabId, maxElements);
}
