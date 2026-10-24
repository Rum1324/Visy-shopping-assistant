import type { BrowserDriver, Result } from "@visy/contracts";
import type { ScriptName } from "../scripts.ts";

/**
 * What the site flows (AmazonFlow) need from a browser. Two implementations:
 *  - ExtensionDriver: the user's real, signed-in Chrome through the Visy extension (the default)
 *  - PlaywrightDriver: a separate Chrome with its own profile (no extension connected, or DRIVER=playwright)
 */
export interface FlowDriver extends BrowserDriver {
  /** background: open behind the tab the user is on. */
  openTab(url: string, opts?: { background?: boolean }): Promise<Result<{ tabId: number }>>;
  /** "commit" returns as soon as the new document starts; callers then wait for what they need. */
  navigate(tabId: number, url: string, waitUntil?: "commit" | "domcontentloaded"): Promise<Result<{ url: string }>>;
  /** Brings the tab to the front, e.g. to hand a bot check to the user. */
  focus(tabId: number): Promise<void>;
  /** Runs a named page script and returns its value. Throws if the script can't run (tab gone, page mid-navigation). */
  extract<T>(tabId: number, name: ScriptName, arg?: unknown): Promise<T>;
  /** Polls a named page script until truthy. Returns false on timeout instead of throwing. */
  waitFor(tabId: number, name: ScriptName, timeoutMs: number, arg?: unknown): Promise<boolean>;
  /** Cheap bot-check test (no full index). */
  isBlocked(tabId: number): Promise<boolean>;
}
