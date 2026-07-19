/**
 * Background service worker.
 *
 * Single source of truth for the register data + matching. The content script
 * and popup send { type: "lookup", query } messages and get search results
 * back. Also wires up the right-click context menu and the keyboard command,
 * and gives quick visual feedback via the toolbar badge.
 */
importScripts("matcher.js");

const DATA_URL = chrome.runtime.getURL("data/sponsors.json");
const CONTEXT_MENU_ID = "ind-check-sponsor";

let loadPromise = null;

/** Load + index the register once; reused across service-worker wake-ups. */
function ensureLoaded() {
  if (INDMatcher.ready()) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = fetch(DATA_URL)
      .then((r) => r.json())
      .then((payload) => {
        INDMatcher.init(payload);
        console.log(`[IND] indexed ${INDMatcher.meta().count} sponsors`);
      })
      .catch((err) => {
        loadPromise = null; // allow retry
        throw err;
      });
  }
  return loadPromise;
}

async function lookup(query, limit) {
  await ensureLoaded();
  return INDMatcher.search(query, { limit });
}

// Warm up as soon as the worker starts.
ensureLoaded();

/* ---------------------------------------------------------------- context menu */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Check "%s" in the IND sponsor register',
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !info.selectionText) return;
  const result = await lookup(info.selectionText);
  flashBadge(tab && tab.id, result.status);
  if (tab && tab.id != null) {
    sendToTab(tab.id, { type: "render", result });
  }
});

/* --------------------------------------------------------------- keyboard command */

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "check-selection") return;
  if (tab && tab.id != null) {
    // Ask the content script to grab the current selection and render.
    sendToTab(tab.id, { type: "lookupSelection" });
  }
});

/* ------------------------------------------------------------------- messaging */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "lookup") {
    lookup(msg.query, msg.limit).then((result) => {
      if (msg.badge && sender.tab && sender.tab.id != null) {
        flashBadge(sender.tab.id, result.status);
      }
      sendResponse(result);
    });
    return true; // async
  }

  if (msg.type === "meta") {
    ensureLoaded().then(() => sendResponse(INDMatcher.meta()));
    return true;
  }
});

/* --------------------------------------------------------------------- helpers */

function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    // Content script not present (e.g. chrome:// pages, PDF viewer). Ignore.
  });
}

const BADGE = {
  recognised: { text: "✓", color: "#137333" },
  possible: { text: "~", color: "#b06000" },
  not_found: { text: "✗", color: "#c5221f" },
};

function flashBadge(tabId, status) {
  const b = BADGE[status] || BADGE.not_found;
  const target = tabId != null ? { tabId } : {};
  try {
    chrome.action.setBadgeBackgroundColor({ color: b.color, ...target });
    chrome.action.setBadgeText({ text: b.text, ...target });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "", ...target }).catch(() => {});
    }, 4000);
  } catch (_) {
    /* setBadgeText can throw if the tab is gone */
  }
}
