import {
  err,
  ok,
  BUDGETS_MS,
  DriverResponseData,
  type Action,
  type ClientMsg,
  type DriverRequest,
  type PageState,
  type Result,
  type ServerMsg,
} from "@visy/contracts";
import type { ScriptName } from "../scripts.ts";
import { CAPTCHA, looksBlocked } from "./blocked.ts";
import type { FlowDriver } from "./flow.ts";

type DriverResponse = Extract<ClientMsg, { type: "driver.response" }>;
type Pending = { op: DriverRequest["op"]; resolve: (r: Result<any>) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Server-side driver for the user's real Chrome: each call becomes a `driver.request` over the WebSocket,
 * and the extension answers with `driver.response` (wire.ts). Wiring, in the WebSocket server:
 *
 *   const driver = new ExtensionDriver((msg) => socket.send(JSON.stringify(msg)));
 *   // on each parsed ClientMsg:  if (msg.type === "driver.response") driver.handle(msg);
 *   // on socket close:           driver.dispose();
 *
 * Same safety as PlaywrightDriver: purchase buttons are refused here, bot checks come back as err("blocked").
 */
export class ExtensionDriver implements FlowDriver {
  private pending = new Map<string, Pending>();
  private last = new Map<number, PageState>();
  private seq = 0;

  constructor(
    private send: (msg: ServerMsg) => void,
    private timeoutMs: number = BUDGETS_MS.driverOp,
  ) {}

  /** Feed every `driver.response` from the socket here. Unknown or late ids are ignored. */
  handle(msg: DriverResponse) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (!msg.ok) return p.resolve({ ok: false, error: msg.error ?? { code: "internal", message: `${p.op} failed in the extension`, retryable: true } });
    const parsed = DriverResponseData[p.op].safeParse(msg.data);
    p.resolve(parsed.success ? ok(parsed.data) : err("parse_failed", `bad ${p.op} payload from extension: ${parsed.error.message}`));
  }

  /** Fails every in-flight call, e.g. when the socket closes. */
  dispose(reason = "extension disconnected") {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(err("internal", reason, true));
      this.pending.delete(id);
    }
  }

  private call<T>(req: DriverRequest, timeoutMs = this.timeoutMs): Promise<Result<T>> {
    const id = `drv-${++this.seq}`;
    if (process.env.DEBUG_DRIVER) {
      const t0 = performance.now();
      const label = `${req.op}${"name" in req ? ` ${req.name}` : ""}${"url" in req ? ` ${req.url}` : ""}`;
      return this.send0<T>(id, req, timeoutMs).then((r) => {
        console.log(`[driver] ${label} → ${r.ok ? "ok" : r.error.code} ${Math.round(performance.now() - t0)} ms`);
        return r;
      });
    }
    return this.send0<T>(id, req, timeoutMs);
  }

  private send0<T>(id: string, req: DriverRequest, timeoutMs: number): Promise<Result<T>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(err("timeout", `${req.op} timed out after ${timeoutMs} ms`, true));
      }, timeoutMs);
      this.pending.set(id, { op: req.op, resolve, timer });
      try {
        this.send({ type: "driver.request", id, req });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(err("internal", `send failed: ${(e as Error).message}`, true));
      }
    });
  }

  /** Tabs open in the user's Chrome, in the "Visy" tab group. */
  openTab(url: string, opts: { background?: boolean } = {}) {
    return this.call<{ tabId: number }>({ op: "openTab", url, ...(opts.background ? { background: true } : {}) }, BUDGETS_MS.marketplaceSearch);
  }

  navigate(tabId: number, url: string, waitUntil?: "commit" | "domcontentloaded") {
    return this.call<{ url: string }>({ op: "navigate", tabId, url, ...(waitUntil ? { waitUntil } : {}) }, BUDGETS_MS.marketplaceSearch);
  }

  async focus(tabId: number) {
    await this.call<{}>({ op: "focus", tabId });
  }

  /** The extension runs the named script with chrome.scripting.executeScript. Throws on failure, like page.evaluate. */
  async extract<T>(tabId: number, name: ScriptName, arg?: unknown): Promise<T> {
    const r = await this.call<{ value?: unknown }>({ op: "extract", tabId, name, ...(arg !== undefined ? { arg } : {}) });
    if (!r.ok) throw new Error(`extract ${name}: ${r.error.message}`);
    return r.data.value as T;
  }

  /** The extension polls (every 100 ms) so the wait survives navigations. */
  async waitFor(tabId: number, name: ScriptName, timeoutMs: number, arg?: unknown): Promise<boolean> {
    const r = await this.call<{ met: boolean }>({ op: "waitFor", tabId, name, timeoutMs, ...(arg !== undefined ? { arg } : {}) }, timeoutMs + 2000);
    return r.ok && r.data.met;
  }

  async isBlocked(tabId: number): Promise<boolean> {
    const probe = await this.extract<string>(tabId, "blockProbe").catch(() => "");
    return CAPTCHA.test(probe);
  }

  async snapshot(tabId: number, maxElements?: number): Promise<Result<PageState>> {
    const r = await this.call<PageState>({ op: "snapshot", tabId, ...(maxElements ? { maxElements } : {}) });
    if (!r.ok) return r;
    if (looksBlocked(r.data)) return err("blocked", "Bot check on the page. The user needs to solve it in their browser.", true);
    this.last.set(tabId, r.data);
    return r;
  }

  async act(tabId: number, action: Action): Promise<Result<{ navigated: boolean }>> {
    if ("idx" in action) {
      const el = this.last.get(tabId)?.elements.find((e) => e.idx === action.idx);
      if (el?.purchaseRisk) return err("forbidden_action", `refusing to touch purchase button "${el.name}"`);
    }
    return this.call<{ navigated: boolean }>({ op: "act", tabId, action });
  }

  screenshot(tabId: number) {
    return this.call<{ dataUrl: string }>({ op: "screenshot", tabId });
  }

  async closeTab(tabId: number) {
    this.last.delete(tabId);
    return this.call<{}>({ op: "closeTab", tabId });
  }
}
