const PURCHASE = /place\s*(your\s*)?order|buy\s*now|submit\s*payment|complete\s*(purchase|order)|pay\s*now/i;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "visy.snapshot") sendResponse({ ok: true, data: snapshot() });
  else if (msg?.type === "visy.act") sendResponse(act(msg.action));
  return false;
});

function snapshot() {
  const nodes = document.querySelectorAll("a, button, input, select, textarea, [role='button'], [role='link'], [role='searchbox'], [role='textbox']");
  const elements = [];
  for (const el of nodes) {
    if (elements.length >= 200) break;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("name") || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (!name) continue;
    const purchaseRisk = PURCHASE.test(name);
    el.dataset.visyIdx = String(elements.length);
    if (purchaseRisk) el.dataset.visyPurchase = "1";
    const section = el.closest("main, nav, header, form, section");
    elements.push({
      idx: elements.length,
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name,
      text: name,
      href: el.href || undefined,
      value: "value" in el ? String(el.value || "") : undefined,
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      section: section?.id || section?.getAttribute("aria-label") || section?.tagName?.toLowerCase(),
      ...(purchaseRisk ? { purchaseRisk: true } : {}),
    });
  }
  return {
    tabId: -1,
    url: location.href,
    title: document.title,
    elements,
    textBlocks: [...document.querySelectorAll("h1, h2, p")]
      .slice(0, 30)
      .map((el) => el.innerText.replace(/\s+/g, " ").trim().slice(0, 240))
      .filter(Boolean),
    fingerprint: `${location.pathname}:${elements.length}`,
    capturedAt: new Date().toISOString(),
  };
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
