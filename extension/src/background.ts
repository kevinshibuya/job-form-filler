// The service worker is deliberately dumb: it opens the panel and relays messages.
// It holds NO state, NO native port, NO logic. (An MV3 worker is torn down after
// ~30s idle; a native port living here would die mid-`claude -p` call.)

import { snapshotKey } from './snapshotKey'
import { broadcast, type RelayDeps } from './relay'

chrome.runtime.onInstalled.addListener(() => {
  // Must stay false: openPanelOnActionClick would suppress action.onClicked.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
})

chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) void chrome.sidePanel.open({ tabId: tab.id })
})

type RelayRequest =
  | { kind: 'inject'; tabId: number }
  | { kind: 'toContent'; tabId: number; frameId?: number; message: unknown }

const relayDeps: RelayDeps = {
  discoverFrames: async (tabId) =>
    (await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href }))
      .map((r) => ({ frameId: r.frameId, url: typeof r.result === 'string' ? r.result : null })),
  sendToFrame: (tabId, frameId, message) => chrome.tabs.sendMessage(tabId, message, { frameId }),
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const req = raw as RelayRequest
  if ((req as { kind?: string })?.kind === 'fromContent') {
    const push = raw as { type?: string; snap?: unknown }
    const tabId = sender.tab?.id
    const frameId = sender.frameId
    if (push.type === 'JFF_SNAPSHOT_PUSH' && tabId != null && frameId != null) {
      // Stamp the identity the content script cannot know, then persist (keyed per
      // tab+frame so parallel frames can never clobber each other) and broadcast.
      void chrome.storage.session.set({ [snapshotKey(tabId, frameId)]: push.snap })
      chrome.runtime.sendMessage({ kind: 'snapshotPush', tabId, frameId, snap: push.snap })
        .catch(() => { /* panel may be closed; storage.session still has it */ })
    }
    return false
  }
  if (req?.kind === 'inject') {
    chrome.scripting
      .executeScript({ target: { tabId: req.tabId, allFrames: true }, files: ['content.js'] })
      .then((results) => sendResponse({ ok: true, frames: results.map((r) => r.frameId) }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (req?.kind === 'toContent') {
    if (req.frameId != null) {
      chrome.tabs
        .sendMessage(req.tabId, req.message, { frameId: req.frameId })
        .then((r) => sendResponse({ ok: true, replies: [{ frameId: req.frameId, url: null, payload: r }], failures: [] }))
        .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
      return true
    }
    broadcast(relayDeps, req.tabId, req.message)
      .then((out) => sendResponse({ ok: true, ...out }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  return false
})

export {}
