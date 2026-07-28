// The service worker is deliberately dumb: it opens the panel and relays messages.
// It holds NO state, NO native port, NO logic. (An MV3 worker is torn down after
// ~30s idle; a native port living here would die mid-`claude -p` call.)

import { snapshotKey } from './snapshotKey'
import { broadcast, isInjectableFrameUrl, type RelayDeps } from './relay'

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

/**
 * Discovery goes through webNavigation, never executeScript({allFrames}): the latter
 * rejects the whole call when any frame of the tab is privileged, which took down
 * both inject and broadcast on real profiles (other extensions inject such frames).
 */
async function injectableFrames(tabId: number): Promise<{ frameId: number; url: string }[]> {
  const frames = await chrome.webNavigation.getAllFrames({ tabId })
  // null means the tab does not exist. Reporting that as "no frames" would dress a
  // real failure up as an honest empty scan; the relay must be able to surface it.
  if (frames == null) throw new Error('tab not found')
  return frames.filter((f) => isInjectableFrameUrl(f.url)).map((f) => ({ frameId: f.frameId, url: f.url }))
}

const relayDeps: RelayDeps = {
  discoverFrames: injectableFrames,
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
    void (async () => {
      try {
        const frames: number[] = []
        for (const f of await injectableFrames(req.tabId)) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: req.tabId, frameIds: [f.frameId] }, files: ['content.js'] })
            frames.push(f.frameId)
          } catch {
            // Per frame, deliberately: one unreachable frame must not fail the scan.
            // The broadcast's send failure then reports this frame WITH its url.
          }
        }
        sendResponse({ ok: true, frames })
      } catch (e: unknown) {
        sendResponse({ ok: false, error: String(e) })
      }
    })()
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
