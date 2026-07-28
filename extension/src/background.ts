// The service worker is deliberately dumb: it opens the panel and relays messages.
// It holds NO state, NO native port, NO logic. (An MV3 worker is torn down after
// ~30s idle; a native port living here would die mid-`claude -p` call.)

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

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const req = raw as RelayRequest
  if (req?.kind === 'inject') {
    chrome.scripting
      .executeScript({ target: { tabId: req.tabId, allFrames: true }, files: ['content.js'] })
      .then((results) => sendResponse({ ok: true, frames: results.map((r) => r.frameId) }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (req?.kind === 'toContent') {
    const opts = req.frameId != null ? { frameId: req.frameId } : {}
    // Broadcast to every frame when no frameId is given, stamping each reply with
    // the frame it came from — the content script cannot know its own frame id.
    if (req.frameId != null) {
      chrome.tabs
        .sendMessage(req.tabId, req.message, opts)
        .then((r) => sendResponse({ ok: true, replies: [{ frameId: req.frameId, payload: r }] }))
        .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
      return true
    }
    // No webNavigation permission: frames are discovered via a no-op executeScript.
    chrome.scripting
      .executeScript({ target: { tabId: req.tabId, allFrames: true }, func: () => true })
      .then(async (frames) => {
        const replies: { frameId: number; payload: unknown }[] = []
        for (const f of frames) {
          try {
            const payload = await chrome.tabs.sendMessage(req.tabId, req.message, { frameId: f.frameId })
            replies.push({ frameId: f.frameId, payload })
          } catch {
            // frame gone or content script not injected there; skip it
          }
        }
        sendResponse({ ok: true, replies })
      })
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  return false
})

export {}
