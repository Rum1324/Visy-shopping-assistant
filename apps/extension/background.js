import { SCRIPTS } from "./scripts.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-visy") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "visy.driver") return;
  runDriver(msg.req).then(sendResponse);
  return true;
});

async function runDriver(req) {
  try {
    // tabId -1 (ACTIVE_TAB in contracts) means the tab the user is looking at.
    if (req.tabId === -1) req = { ...req, tabId: await activeTabId() };
    if (req.op === "openTab") return ok(await openTab(req.url, req.background));
    if (req.op === "navigate") return ok(await navigate(req.tabId, req.url, req.waitUntil));
    if (req.op === "focus") {
      const tab = await chrome.tabs.update(req.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return ok({});
    }
    if (req.op === "extract") return ok({ value: await runScript(req.tabId, req.name, req.arg) });
    if (req.op === "waitFor") return ok({ met: await waitFor(req.tabId, req.name, req.arg, req.timeoutMs) });
    if (req.op === "closeTab") {
      await chrome.tabs.remove(req.tabId);
      return ok({});
    }
    if (req.op === "screenshot") {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
      return ok({ dataUrl });
    }
    if (req.op === "snapshot" || req.op === "act") {
      const page = await askPage(
        req.tabId,
        req.op === "snapshot" ? { type: "visy.snapshot", maxElements: req.maxElements } : { type: "visy.act", action: req.action },
      );
      if (!page?.ok) return page ?? fail("internal", "No reply from the page", true);
      if (req.op === "snapshot") page.data.tabId = req.tabId;
      return page;
    }
    return fail("internal", `Unknown driver op ${req.op}`, false);
  } catch (e) {
    return fail("internal", e instanceof Error ? e.message : "Driver failed", true);
  }
}

async function openTab(url, background) {
  const tab = await chrome.tabs.create({ url, active: !background });
  const groups = await chrome.tabGroups.query({ title: "Visy" });
  if (groups[0]) await chrome.tabs.group({ groupId: groups[0].id, tabIds: tab.id });
  else {
    const groupId = await chrome.tabs.group({ tabIds: tab.id });
    await chrome.tabGroups.update(groupId, { title: "Visy", color: "blue" });
  }
  return { tabId: tab.id };
}

// Resolves once the new document has committed (or parsed), so the next script runs on the new page, not the old one.
async function navigate(tabId, url, waitUntil = "commit") {
  const event = waitUntil === "domcontentloaded" ? chrome.webNavigation.onDOMContentLoaded : chrome.webNavigation.onCommitted;
  let listener;
  const done = new Promise((resolve) => {
    const timer = setTimeout(resolve, 15000);
    listener = (d) => {
      if (d.tabId !== tabId || d.frameId !== 0) return;
      if (d.url.startsWith("about:") && !url.startsWith("about:")) return;
      clearTimeout(timer);
      resolve();
    };
    event.addListener(listener);
  });
  try {
    await chrome.tabs.update(tabId, { url });
    await done;
  } finally {
    event.removeListener(listener);
  }
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url || tab.pendingUrl || url };
}

// Named page scripts from scripts.js (generated from the server's navigator/scripts.ts): MV3 can't eval strings.
// The result is page data, untrusted.
async function runScript(tabId, name, arg) {
  const func = SCRIPTS[name];
  if (!func) throw new Error(`Unknown page script "${name}". Run npm run gen-indexer -w @visy/server and reload the extension.`);
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: [arg ?? null] });
  return res?.result;
}

// Polls here, not in the page, so the wait survives the page navigating underneath it.
async function waitFor(tabId, name, arg, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (true) {
    try {
      if (await runScript(tabId, name, arg)) return true;
    } catch (e) {
      // Mid-navigation the frame can't be scripted for a moment; a closed tab or unknown script is final.
      if (/No tab with id|Unknown page script/.test(e?.message ?? "")) throw e;
    }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id == null) throw new Error("No active tab");
  return tab.id;
}

async function askPage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["indexer.js", "content.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function ok(data) {
  return { ok: true, data };
}
function fail(code, message, retryable) {
  return { ok: false, error: { code, message, retryable } };
}
