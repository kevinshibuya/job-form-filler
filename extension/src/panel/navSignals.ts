/** How long after a webNavigation-sourced event a tabs.onUpdated 'loading' for
 *  the same tab counts as the SAME navigation (fallback dedupe). */
export const NAV_FALLBACK_DEDUPE_MS = 1500

export type NavEvent =
  | { type: 'navigated'; tabId: number; frameId: number; url: string }
  | { type: 'activated'; tabId: number }
  | { type: 'removed'; tabId: number }

/**
 * S3: navigation truth comes from webNavigation, carrying frameId + the EVENT
 * url — the TRM/Ashby reference job submits inside a cross-origin IFRAME and
 * Workday wizards are History-API SPAs; `tabs.onUpdated` sees neither, so it
 * stays only as a deduped fallback. `chrome.tabs.Tab.url` may still hold the
 * pre-nav url, which is why the event's url is the one forwarded. Activation
 * is filtered to the panel's own window (multi-window rule); removal always
 * forwards. The module reports raw events for ALL tabs — routing them to
 * sessions is the panel's job.
 */
export function createNavSignals(windowId: number, onEvent: (e: NavEvent) => void): () => void {
  const lastWebNav = new Map<number, number>()
  const navigated = (d: { tabId: number; frameId: number; url: string }): void => {
    lastWebNav.set(d.tabId, Date.now())
    onEvent({ type: 'navigated', tabId: d.tabId, frameId: d.frameId, url: d.url })
  }
  const onCommitted = (d: { tabId: number; frameId: number; url: string }): void => navigated(d)
  const onHistory = (d: { tabId: number; frameId: number; url: string }): void => navigated(d)
  const onUpdated = (id: number, change: chrome.tabs.TabChangeInfo): void => {
    if (change.status !== 'loading') return
    // Chrome omits `url` unless it CHANGED. A URL-less loading tick carries
    // nothing webNavigation doesn't already provide — and forwarding '' would
    // classify as a cross-site move and PARK a live session mid-wizard.
    if (change.url === undefined) return
    const t = lastWebNav.get(id)
    if (t !== undefined && Date.now() - t < NAV_FALLBACK_DEDUPE_MS) return
    onEvent({ type: 'navigated', tabId: id, frameId: 0, url: change.url })
  }
  const onActivated = (info: chrome.tabs.TabActiveInfo): void => {
    if (info.windowId !== windowId) return
    onEvent({ type: 'activated', tabId: info.tabId })
  }
  const onRemoved = (id: number): void => {
    // F11: the dedupe window is 1.5s wide and a closed tab emits no further
    // navigations, so this entry is dead weight the moment the tab is gone.
    // Without the delete the map grows one entry per tab ever navigated, for
    // the whole life of the panel.
    lastWebNav.delete(id)
    onEvent({ type: 'removed', tabId: id })
  }

  chrome.webNavigation.onCommitted.addListener(onCommitted)
  chrome.webNavigation.onHistoryStateUpdated.addListener(onHistory)
  chrome.tabs.onUpdated.addListener(onUpdated)
  chrome.tabs.onActivated.addListener(onActivated)
  chrome.tabs.onRemoved.addListener(onRemoved)
  return () => {
    chrome.webNavigation.onCommitted.removeListener(onCommitted)
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistory)
    chrome.tabs.onUpdated.removeListener(onUpdated)
    chrome.tabs.onActivated.removeListener(onActivated)
    chrome.tabs.onRemoved.removeListener(onRemoved)
  }
}
