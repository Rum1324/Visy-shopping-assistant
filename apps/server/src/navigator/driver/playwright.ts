import { chromium, type BrowserContext, type Page } from "playwright";
import { err, ok, BUDGETS_MS, type Action, type BrowserDriver, type PageState, type Result } from "@visy/contracts";
import { INDEXER_JS } from "./indexer.ts";

const CAPTCHA = /validateCaptcha|captcha|press (&|and) hold|robot or human|enter the characters you see|amazon\.com\/checkpoint\//i;
const CHALLENGE_SECTION = /tmms-challenge|checkpointForm/i;

/**
 * Local Chromium driver. Headed + persistent profile by default: Amazon blocks headless datacenter traffic,
 * and a persistent profile keeps the user's own login. We never solve CAPTCHAs: snapshot returns err("blocked").
 */
export class PlaywrightDriver implements BrowserDriver {
  private ctx?: BrowserContext;
  private pages = new Map<number, Page>();
  private last = new Map<number, PageState>();
  private nextId = 1;

  constructor(private opts: { headless?: boolean; profileDir?: string } = {}) {}

  private async context() {
    if (this.ctx) return this.ctx;
    const launch = {
      headless: this.opts.headless ?? process.env.HEADLESS === "1",
      viewport: { width: 1280, height: 900 },
    };
    const dir = this.opts.profileDir ?? ".visy-profile";
    try {
      // Real Chrome looks less like a bot than bundled Chromium.
      this.ctx = await chromium.launchPersistentContext(dir, { ...launch, channel: "chrome" });
    } catch {
      this.ctx = await chromium.launchPersistentContext(dir, launch);
    }
    return this.ctx;
  }

  page(tabId: number) {
    return this.pages.get(tabId);
  }

  async openTab(url: string): Promise<Result<{ tabId: number }>> {
    try {
      const ctx = await this.context();
      const page = ctx.pages().find((p) => p.url() === "about:blank" && ![...this.pages.values()].includes(p)) ?? (await ctx.newPage());
      const tabId = this.nextId++;
      this.pages.set(tabId, page);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: BUDGETS_MS.marketplaceSearch });
      return ok({ tabId });
    } catch (e) {
      return err("internal", `openTab failed: ${(e as Error).message}`, true);
    }
  }

  async navigate(tabId: number, url: string): Promise<Result<{ url: string }>> {
    const page = this.pages.get(tabId);
    if (!page) return err("not_found", `no tab ${tabId}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: BUDGETS_MS.marketplaceSearch });
      return ok({ url: page.url() });
    } catch (e) {
      return err("timeout", `navigate failed: ${(e as Error).message}`, true);
    }
  }

  async snapshot(tabId: number, maxElements = 300): Promise<Result<PageState>> {
    const page = this.pages.get(tabId);
    if (!page) return err("not_found", `no tab ${tabId}`);
    try {
      const raw = (await page.evaluate(`(${INDEXER_JS})(${maxElements})`)) as Omit<PageState, "tabId" | "capturedAt">;
      const state: PageState = { ...raw, tabId, capturedAt: new Date().toISOString() };
      if (
        CAPTCHA.test(state.url) ||
        CAPTCHA.test(state.title) ||
        state.textBlocks.slice(0, 15).some((t) => CAPTCHA.test(t)) ||
        state.elements.some((e) => CHALLENGE_SECTION.test(e.section ?? ""))
      ) {
        return err("blocked", "Bot check on the page. The user needs to solve it in the browser window.", true);
      }
      this.last.set(tabId, state);
      return ok(state);
    } catch (e) {
      return err("internal", `snapshot failed: ${(e as Error).message}`, true);
    }
  }

  async act(tabId: number, action: Action): Promise<Result<{ navigated: boolean }>> {
    const page = this.pages.get(tabId);
    if (!page) return err("not_found", `no tab ${tabId}`);
    if ("idx" in action) {
      const el = this.last.get(tabId)?.elements.find((e) => e.idx === action.idx);
      if (el?.purchaseRisk) return err("forbidden_action", `refusing to touch purchase button "${el.name}"`);
    }
    const before = page.url();
    try {
      const loc = "idx" in action ? page.locator(`[data-visy-idx="${action.idx}"]`).first() : undefined;
      const t = { timeout: BUDGETS_MS.driverOp };
      switch (action.kind) {
        case "click":
          await loc!.click(t);
          break;
        case "type":
          await loc!.fill(action.text, t);
          if (action.submit) await loc!.press("Enter", t);
          break;
        case "select":
          await loc!.selectOption(action.value, t);
          break;
        case "scroll":
          await page.mouse.wheel(0, (action.direction === "down" ? 1 : -1) * (action.amount ?? 800));
          break;
        case "press":
          await page.keyboard.press(action.key);
          break;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      return ok({ navigated: page.url() !== before });
    } catch (e) {
      return err("internal", `act ${action.kind} failed: ${(e as Error).message}`, true);
    }
  }

  async screenshot(tabId: number): Promise<Result<{ dataUrl: string }>> {
    const page = this.pages.get(tabId);
    if (!page) return err("not_found", `no tab ${tabId}`);
    const buf = await page.screenshot({ type: "jpeg", quality: 60 });
    return ok({ dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}` });
  }

  async closeTab(tabId: number): Promise<Result<{}>> {
    await this.pages.get(tabId)?.close();
    this.pages.delete(tabId);
    this.last.delete(tabId);
    return ok({});
  }

  /** Not in BrowserDriver: site-specific extraction (result cards, cart subtotal). The extension will need an equivalent op. */
  async evaluate<T>(tabId: number, js: string): Promise<T> {
    return (await this.pages.get(tabId)!.evaluate(js)) as T;
  }

  async close() {
    await this.ctx?.close();
  }
}
