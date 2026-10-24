import { err, ok, type ElementPicker, type PageState, type Result } from "@visy/contracts";
import type { PlaywrightDriver } from "../driver/playwright.ts";
import { pickWithChain, type ChainPick } from "../chain.ts";
import { strictPicker, type FindStep } from "../pickers/common.ts";
import type { MemoryPicker } from "../pickers/memory.ts";

export type AmazonResult = { asin: string; title: string; price: string | null; rating: string | null; sponsored: boolean };

// Tier 0: deterministic extraction, no AI. Amazon's result cards are stable enough for a hackathon.
const RESULT_SEL = '[data-component-type="s-search-result"][data-asin]';
const RESULTS_JS = `Array.from(document.querySelectorAll('${RESULT_SEL}')).map((c) => ({
  asin: c.getAttribute('data-asin'),
  title: (c.querySelector('h2')?.innerText || '').trim(),
  price: c.querySelector('.a-price .a-offscreen')?.textContent?.trim() || null,
  rating: c.querySelector('.a-icon-alt')?.textContent?.trim() || null,
  sponsored: !!c.querySelector('.puis-sponsored-label-text, [aria-label*="Sponsored"]') || /^Sponsored/.test((c.innerText || '').trim()),
})).filter((r) => r.asin && r.title)`;

const SUBTOTAL_SEL = "#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox";
const SUBTOTAL_JS = `(document.querySelector('${SUBTOTAL_SEL}')?.innerText || '').trim()`;
const CHALLENGE_JS = `!!document.querySelector('#checkpointForm, form[action*=validateCaptcha]')`;
// After Add to Cart Amazon either navigates (cart / smart wagon), shows an "Added to cart" sheet, or offers a warranty.
const ADDED_JS = (before: string) =>
  `location.href !== ${JSON.stringify(before)} || /added to (your )?cart/i.test(document.body.innerText.slice(0, 20000)) || !!document.querySelector('#attachSiNoCoverage, #attach-warranty-pane, #NATC_SMART_WAGON_CONF_MSG_SUCCESS, #sw-atc-confirmation')`;
const WARRANTY_JS = `!!document.querySelector('#attachSiNoCoverage, #attach-warranty-pane')`;

export const STEPS = {
  searchBox: { kind: "find_control", intent: "searchbox: Search Amazon | section: navigation bar", then: "type" },
  addToCart: { kind: "find_control", intent: "button: Add to Cart | section: buy box", then: "click" },
} satisfies Record<string, FindStep>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AmazonFlow {
  tabId?: number;
  /** Sub-step timings for the last call, for the demo's breakdown. */
  marks: Record<string, number> = {};

  constructor(
    private driver: PlaywrightDriver,
    private pickers: ElementPicker[],
    private memory?: MemoryPicker,
    private onBlocked: () => Promise<void> = async () => {},
  ) {}

  private mark(label: string, t0: number) {
    this.marks[label] = Math.round((this.marks[label] ?? 0) + performance.now() - t0);
  }

  private async blockedGate(): Promise<Result<{}>> {
    if (!(await this.driver.isBlocked(this.tabId!))) return ok({});
    await this.onBlocked();
    return (await this.driver.isBlocked(this.tabId!)) ? err("blocked", "bot check not solved") : ok({});
  }

  private async goto(url: string, waitUntil: "commit" | "domcontentloaded" = "commit") {
    const t0 = performance.now();
    if (this.tabId === undefined) {
      const t = await this.driver.openTab("about:blank");
      if (!t.ok) return t;
      this.tabId = t.data.tabId;
    }
    const r = await this.driver.navigate(this.tabId, url, waitUntil);
    this.mark("navigate", t0);
    return r;
  }

  /**
   * Snapshot → pick → act, starting while the page is still loading, re-snapshotting every ~150 ms.
   * While loading: memory, plus Moss in strict mode (trusted only on an exact role+name match, since on a
   * partial page Moss would happily pick e.g. the nav's "Add to cart, shift, option, K" shortcut). Moss also
   * embeds the new element text as it streams in, so the work overlaps the network wait.
   * Full chain (Moss by gap, then Claude) once the DOM is ready or the deadline passes: at most one Claude call.
   */
  async step(step: FindStep, deadlineMs = 6000): Promise<Result<ChainPick>> {
    const fast = this.pickers.filter((p) => p.name !== "claude").map((p) => (p.name === "moss" ? strictPicker(p) : p));
    const end = performance.now() + deadlineMs;
    let attempts = 0;
    while (true) {
      attempts++;
      let t0 = performance.now();
      const ready = (await this.driver.evaluate<string>(this.tabId!, "document.readyState").catch(() => "loading")) !== "loading";
      const s = await this.driver.snapshot(this.tabId!);
      this.mark("snapshot", t0);
      if (!s.ok) {
        if (s.error.code === "blocked") {
          const g = await this.blockedGate();
          if (!g.ok) return g;
          continue;
        }
        if (performance.now() > end) return s;
        await sleep(150);
        continue;
      }
      const final = ready || performance.now() > end;
      t0 = performance.now();
      const pick = await pickWithChain(final ? this.pickers : fast, s.data, step, this.memory);
      this.mark("pick", t0);
      if (!pick.ok) {
        if (final) return pick;
        await sleep(150);
        continue;
      }
      const action =
        step.then === "type"
          ? ({ kind: "type", idx: pick.data.idx, text: step.text ?? "", submit: true } as const)
          : step.then === "select"
            ? ({ kind: "select", idx: pick.data.idx, value: step.text ?? "" } as const)
            : ({ kind: "click", idx: pick.data.idx } as const);
      t0 = performance.now();
      const r = await this.driver.act(this.tabId!, action);
      this.mark("act", t0);
      this.marks.attempts = attempts;
      if (!r.ok) return r;
      return ok(pick.data);
    }
  }

  /** viaUi=false uses the shortcut URL (fastest). viaUi=true types into the search box through the picker chain. */
  async search(query: string, viaUi = false): Promise<Result<AmazonResult[]>> {
    this.marks = {};
    if (viaUi) {
      const g = await this.goto("https://www.amazon.com/");
      if (!g.ok) return g;
      const r = await this.step({ ...STEPS.searchBox, text: query });
      if (!r.ok) return r;
    } else {
      const g = await this.goto(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`);
      if (!g.ok) return g;
    }
    const t0 = performance.now();
    await this.driver.waitFor(this.tabId!, `!!document.querySelector('${RESULT_SEL}') || ${CHALLENGE_JS}`, 10_000);
    this.mark("wait results", t0);
    const g = await this.blockedGate();
    if (!g.ok) return g;
    // The page streams in: cards can exist before their titles are parsed. Wait for 6 titled cards or DOM ready.
    const t1 = performance.now();
    await this.driver.waitFor(this.tabId!, `document.querySelectorAll('${RESULT_SEL} h2').length >= 6 || document.readyState !== 'loading'`, 8000);
    this.mark("wait titles", t1);
    let results = await this.driver.evaluate<AmazonResult[]>(this.tabId!, RESULTS_JS);
    if (results.length < 3) {
      await this.driver.waitFor(this.tabId!, `document.readyState !== 'loading'`, 5000);
      results = await this.driver.evaluate<AmazonResult[]>(this.tabId!, RESULTS_JS);
    }
    return results.length ? ok(results) : err("parse_failed", "no result cards found");
  }

  async open(asin: string) {
    this.marks = {};
    return this.goto(`https://www.amazon.com/dp/${asin}`);
  }

  async addToCart() {
    this.marks = {};
    const before = await this.driver.evaluate<string>(this.tabId!, "location.href");
    const r = await this.step(STEPS.addToCart);
    if (!r.ok) return r;
    const t0 = performance.now();
    await this.driver.waitFor(this.tabId!, ADDED_JS(before), 5000);
    this.mark("wait confirmation", t0);
    // Decline the warranty upsell if shown. Deterministic: exact "No Thanks".
    if (await this.driver.evaluate<boolean>(this.tabId!, WARRANTY_JS).catch(() => false)) {
      await sleep(300); // the pane animates in
      const s = await this.driver.snapshot(this.tabId!);
      const no = s.ok ? s.data.elements.find((e) => /^no,? thanks$/i.test(e.name)) : undefined;
      if (no) await this.driver.act(this.tabId!, { kind: "click", idx: no.idx });
    }
    return r;
  }

  /** Goes to the cart and reads the subtotal. Never proceeds to checkout's final button. */
  async viewCart(): Promise<Result<{ subtotal: string }>> {
    this.marks = {};
    const g = await this.goto("https://www.amazon.com/gp/cart/view.html");
    if (!g.ok) return g;
    const t0 = performance.now();
    await this.driver.waitFor(this.tabId!, `!!document.querySelector('${SUBTOTAL_SEL}')`, 8000);
    this.mark("wait subtotal", t0);
    return ok({ subtotal: await this.driver.evaluate<string>(this.tabId!, SUBTOTAL_JS) });
  }
}
