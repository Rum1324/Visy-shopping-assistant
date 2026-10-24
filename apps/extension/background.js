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
    if (req.op === "openTab") return ok(await openTab(req.url));
    if (req.op === "navigate") {
      await chrome.tabs.update(req.tabId, { url: req.url });
      return ok({ url: req.url });
    }
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

async function openTab(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  const groups = await chrome.tabGroups.query({ title: "Visy" });
  if (groups[0]) await chrome.tabs.group({ groupId: groups[0].id, tabIds: tab.id });
  else {
    const groupId = await chrome.tabs.group({ tabIds: tab.id });
    await chrome.tabGroups.update(groupId, { title: "Visy", color: "blue" });
  }
  return { tabId: tab.id };
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
