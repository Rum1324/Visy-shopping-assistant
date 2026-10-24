import { err, ok, type ElementPicker, type PageState, type Result } from "@visy/contracts";
import type { PlaywrightDriver } from "../driver/playwright.ts";
import { pickWithChain } from "../chain.ts";
import type { FindStep } from "../pickers/common.ts";
import type { MemoryPicker } from "../pickers/memory.ts";

export type AmazonResult = { asin: string; title: string; price: string | null; rating: string | null; sponsored: boolean };

// Tier 0: deterministic extraction, no AI. Amazon's result cards are stable enough for a hackathon.
const RESULTS_JS = `Array.from(document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')).map((c) => ({
  asin: c.getAttribute('data-asin'),
  title: (c.querySelector('h2')?.innerText || '').trim(),
  price: c.querySelector('.a-price .a-offscreen')?.textContent?.trim() || null,
  rating: c.querySelector('.a-icon-alt')?.textContent?.trim() || null,
  sponsored: !!c.querySelector('.puis-sponsored-label-text, [aria-label*="Sponsored"]') || /^Sponsored/.test((c.innerText || '').trim()),
})).filter((r) => r.asin && r.title)`;

const SUBTOTAL_JS = `(document.querySelector('#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox')?.innerText || '').trim()`;

export const STEPS = {
  searchBox: { kind: "find_control", intent: "searchbox: Search Amazon | section: navigation bar", then: "type" },
  addToCart: { kind: "find_control", intent: "button: Add to Cart | section: buy box", then: "click" },
} satisfies Record<string, FindStep>;

export class AmazonFlow {
  tabId?: number;

  constructor(
    private driver: PlaywrightDriver,
    private pickers: ElementPicker[],
    private memory?: MemoryPicker,
    private onBlocked: () => Promise<void> = async () => {},
  ) {}

  private async snap(): Promise<Result<PageState>> {
    let s = await this.driver.snapshot(this.tabId!);
    if (!s.ok && s.error.code === "blocked") {
      await this.onBlocked();
      s = await this.driver.snapshot(this.tabId!);
    }
    return s;
  }

  private async goto(url: string) {
    if (this.tabId === undefined) {
      const t = await this.driver.openTab(url);
      if (!t.ok) return t;
      this.tabId = t.data.tabId;
      return ok({ url });
    }
    return this.driver.navigate(this.tabId, url);
  }

  /** Snapshot, pick with the chain, act. */
  async step(step: FindStep) {
    const s = await this.snap();
    if (!s.ok) return s;
    const pick = await pickWithChain(this.pickers, s.data, step, this.memory);
    if (!pick.ok) return pick;
    const action =
      step.then === "type"
        ? ({ kind: "type", idx: pick.data.idx, text: step.text ?? "", submit: true } as const)
        : step.then === "select"
          ? ({ kind: "select", idx: pick.data.idx, value: step.text ?? "" } as const)
          : ({ kind: "click", idx: pick.data.idx } as const);
    const r = await this.driver.act(this.tabId!, action);
    if (!r.ok) return r;
    return ok(pick.data);
  }

  /** viaUi=false uses the shortcut URL (fastest). viaUi=true types into the search box through the picker chain. */
  async search(query: string, viaUi = false): Promise<Result<AmazonResult[]>> {
    if (viaUi) {
      const g = await this.goto("https://www.amazon.com/");
      if (!g.ok) return g;
      const r = await this.step({ ...STEPS.searchBox, text: query });
      if (!r.ok) return r;
      await this.driver.page(this.tabId!)!.waitForSelector('[data-component-type="s-search-result"]', { timeout: 8000 }).catch(() => {});
    } else {
      const g = await this.goto(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`);
      if (!g.ok) return g;
    }
    const s = await this.snap(); // also catches the CAPTCHA page
    if (!s.ok) return s;
    const results = await this.driver.evaluate<AmazonResult[]>(this.tabId!, RESULTS_JS);
    return results.length ? ok(results) : err("parse_failed", "no result cards found");
  }

  async open(asin: string) {
    return this.goto(`https://www.amazon.com/dp/${asin}`);
  }

  async addToCart() {
    const r = await this.step(STEPS.addToCart);
    if (!r.ok) return r;
    // Decline warranty / add-on upsells if Amazon shows them. Deterministic: exact "No Thanks".
    await new Promise((res) => setTimeout(res, 1200));
    const s = await this.driver.snapshot(this.tabId!);
    const no = s.ok ? s.data.elements.find((e) => /^no,? thanks$/i.test(e.name)) : undefined;
    if (no) await this.driver.act(this.tabId!, { kind: "click", idx: no.idx });
    return r;
  }

  /** Goes to the cart and reads the subtotal. Never proceeds to checkout's final button. */
  async viewCart(): Promise<Result<{ subtotal: string }>> {
    const g = await this.goto("https://www.amazon.com/gp/cart/view.html");
    if (!g.ok) return g;
    return ok({ subtotal: await this.driver.evaluate<string>(this.tabId!, SUBTOTAL_JS) });
  }
}
