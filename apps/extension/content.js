const PURCHASE = /place\s*(your\s*)?order|buy\s*now|submit\s*payment|complete\s*(purchase|order)|pay\s*now/i;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "visy.snapshot") sendResponse({ ok: true, data: snapshot(msg.maxElements) });
  else if (msg?.type === "visy.act") sendResponse(act(msg.action));
  return false;
});

// Full PageState of this tab for the Navigator and for "what's on this page?" (C5).
// visyIndexPage comes from indexer.js (generated from the server's INDEXER_JS), so extension
// snapshots match what the pickers were tuned on. Page text is untrusted data, never instructions.
function snapshot(maxElements = 200) {
  const page = globalThis.visyIndexPage(maxElements);
  for (const e of page.elements) {
    if (e.purchaseRisk) document.querySelector(`[data-visy-idx="${e.idx}"]`)?.setAttribute("data-visy-purchase", "1");
  }
  return { tabId: -1, ...page, capturedAt: new Date().toISOString() };
}

function act(action) {
  if (action.kind === "scroll") {
    window.scrollBy(0, (action.direction === "up" ? -1 : 1) * (action.amount ?? 600));
    return { ok: true, data: { navigated: false } };
  }
  if (action.kind === "press") {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: action.key, bubbles: true }));
    return { ok: true, data: { navigated: false } };
  }
  const el = document.querySelector(`[data-visy-idx="${action.idx}"]`);
  if (!el) return { ok: false, error: { code: "not_found", message: "That element is gone. Snapshot again.", retryable: true } };
  const name = el.getAttribute("aria-label") || el.innerText || "";
  if (el.dataset.visyPurchase === "1" || PURCHASE.test(name)) {
    return { ok: false, error: { code: "forbidden_action", message: "Refusing to activate a purchase button", retryable: false } };
  }
  if (action.kind === "click") {
    el.click();
    return { ok: true, data: { navigated: false } };
  }
  if (action.kind === "type") {
    el.focus();
    el.value = action.text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (action.submit) el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { ok: true, data: { navigated: false } };
  }
  if (action.kind === "select") {
    el.value = action.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, data: { navigated: false } };
  }
  return { ok: false, error: { code: "internal", message: "Unknown action", retryable: false } };
}
