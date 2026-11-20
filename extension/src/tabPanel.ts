/** Where the Side panel's page lives in the extension's bundle. The manifest
 *  declares no panel, so vite.config.ts registers this file as a build input,
 *  which keeps its path. */
export const PANEL_PATH = 'src/panel/index.html'

/** The Side panel's address for one tab. The panel reads its tab from it and
 *  stays bound to that tab for its whole life. */
export const panelPathFor = (tabId: number): string => `${PANEL_PATH}?tabId=${tabId}`

/** The slice of `chrome.sidePanel` the action click uses. Tests pass a fake. */
export interface SidePanelApi {
  setOptions(options: { tabId: number; path: string; enabled: boolean }): Promise<void>
  open(options: { tabId: number }): Promise<void>
}

const swallow = (): void => { /* the click has nothing to report to */ }

/**
 * The action click: enable the Side panel for the clicked tab alone and open
 * it there. Chrome then hides it on other tabs and brings it back with its own.
 *
 * Both calls go out in the same synchronous turn. `open` must run inside the
 * click's user gesture, and awaiting `setOptions` first loses it
 * (docs/research/apply-by-email-facts.md, question 6).
 */
export function openTabPanel(api: SidePanelApi, tab: { id?: number }): void {
  const tabId = tab.id
  if (tabId == null) return
  api.setOptions({ tabId, path: panelPathFor(tabId), enabled: true }).catch(swallow)
  api.open({ tabId }).catch(swallow)
}
