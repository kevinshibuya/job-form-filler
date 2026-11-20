import { PANEL_PATH } from '../tabPanel'

/**
 * The tabs whose Side panel is open now, read from the extension's live
 * documents: every panel document carries its tab in its address. `ownTab` is
 * this panel's tab, counted whatever its address says.
 *
 * Null when that cannot be known: the API is missing or refuses, or another
 * panel document carries no tab. The caller then removes nothing, since a wrong
 * answer would remove a Session another panel is showing.
 */
export async function openPanelTabIds(ownTab: number | null): Promise<ReadonlySet<number> | null> {
  const open = new Set<number>()
  if (ownTab !== null) open.add(ownTab)
  let contexts: chrome.runtime.ExtensionContext[]
  try {
    contexts = await chrome.runtime.getContexts({})
  } catch {
    return null
  }
  const panelUrl = chrome.runtime.getURL(PANEL_PATH)
  for (const c of contexts) {
    const url = c.documentUrl
    if (url === undefined || url.split(/[?#]/)[0] !== panelUrl) continue
    const raw = new URL(url).searchParams.get('tabId')
    if (raw === null) {
      // This document is a panel bound to the tab active as it started. Only
      // this panel knows which: this document is the one place that is safe.
      if (url === location.href) continue
      return null
    }
    const tabId = Number(raw)
    if (!Number.isInteger(tabId)) return null
    open.add(tabId)
  }
  return open
}
