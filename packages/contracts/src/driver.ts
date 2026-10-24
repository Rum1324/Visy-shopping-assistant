import { z } from "zod";
import { IsoDate, type Result } from "./common.ts";

/**
 * One interactive element, numbered by the content script. Jev and Claude choose actions by `idx`.
 * `idx` is only valid for the PageState it came from. Re-snapshot after any navigation.
 */
export const PageElement = z.object({
  idx: z.number().int().nonnegative(),
  role: z.string(), // "button", "link", "textbox", "combobox", "checkbox", …
  name: z.string(), // accessible name
  text: z.string().optional(),
  href: z.string().optional(),
  value: z.string().optional(),
  checked: z.boolean().optional(),
  disabled: z.boolean().optional(),
  /** Nearest landmark or region, e.g. "main buy box" or "sponsored carousel". Tells apart duplicate labels like the many "Add to cart" buttons on one page. */
  section: z.string().optional(),
  /** Set by the content script for "Place order", "Buy now", "Submit payment" and similar. The Navigator must never click these. */
  purchaseRisk: z.boolean().optional(),
});
export type PageElement = z.infer<typeof PageElement>;

export const PageState = z.object({
  tabId: z.number().int(),
  url: z.string(),
  title: z.string(),
  elements: z.array(PageElement),
  /** Visible text, in reading order, truncated to stay small. UNTRUSTED. */
  textBlocks: z.array(z.string()),
  /** Hash of the page's structural layout. Used by RecipeCache to detect UI changes. */
  fingerprint: z.string(),
  capturedAt: IsoDate,
});
export type PageState = z.infer<typeof PageState>;

/** Deliberately has no "submit order" kind. */
export const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), idx: z.number().int() }),
  z.object({ kind: z.literal("type"), idx: z.number().int(), text: z.string(), submit: z.boolean().optional() }),
  z.object({ kind: z.literal("select"), idx: z.number().int(), value: z.string() }),
  z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down"]), amount: z.number().optional() }),
  z.object({ kind: z.literal("press"), key: z.string() }),
]);
export type Action = z.infer<typeof Action>;

export const DriverRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("openTab"), url: z.url() }),
  z.object({ op: z.literal("navigate"), tabId: z.number().int(), url: z.url() }),
  z.object({ op: z.literal("snapshot"), tabId: z.number().int(), maxElements: z.number().int().optional() }),
  z.object({ op: z.literal("act"), tabId: z.number().int(), action: Action }),
  z.object({ op: z.literal("screenshot"), tabId: z.number().int() }),
  z.object({ op: z.literal("closeTab"), tabId: z.number().int() }),
]);
export type DriverRequest = z.infer<typeof DriverRequest>;

/** Response payload schema for each op. Validate driver.response.data with DriverResponseData[req.op]. */
export const DriverResponseData = {
  openTab: z.object({ tabId: z.number().int() }),
  navigate: z.object({ url: z.string() }),
  snapshot: PageState,
  act: z.object({ navigated: z.boolean() }),
  screenshot: z.object({ dataUrl: z.string() }),
  closeTab: z.object({}),
} as const satisfies Record<DriverRequest["op"], z.ZodType>;

/**
 * The eyes and hands. Two implementations:
 *  - ExtensionDriver (server side): forwards over the WebSocket to the user's Chrome
 *  - PlaywrightDriver (server side): local or cloud Chromium, for dev without the extension and for a future mobile client
 */
export interface BrowserDriver {
  openTab(url: string): Promise<Result<{ tabId: number }>>;
  navigate(tabId: number, url: string): Promise<Result<{ url: string }>>;
  snapshot(tabId: number, maxElements?: number): Promise<Result<PageState>>;
  act(tabId: number, action: Action): Promise<Result<{ navigated: boolean }>>;
  screenshot(tabId: number): Promise<Result<{ dataUrl: string }>>;
  closeTab(tabId: number): Promise<Result<{}>>;
}
