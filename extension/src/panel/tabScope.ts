/** Why the panel's state stopped being meaningful. */
export type ResetReason = 'activated' | 'navigated' | 'removed'

/**
 * The panel binds to ONE tab and clears its state whenever that binding stops
 * being meaningful: another tab is activated, the bound tab navigates (a Workday
 * wizard step is entirely new DOM), or the bound tab closes. Without this, a
 * wizard step would show stale fields from the previous page.
 *
 * The REASON is reported because clearing and re-scanning are different decisions.
 * Every reason clears; only `navigated` is a new page worth another scan. Firing a
 * scan on `activated` would spend one batched `claude -p` call per tab switch, and
 * on `removed` it would call chrome.tabs.get on a tab that no longer exists.
 */
export function createTabScope(tabId: number, onReset: (reason: ResetReason) => void): () => void {
  const onActivated = (info: chrome.tabs.TabActiveInfo): void => {
    if (info.tabId !== tabId) onReset('activated')
  }
  const onUpdated = (id: number, change: chrome.tabs.TabChangeInfo): void => {
    if (id === tabId && change.status === 'loading') onReset('navigated')
  }
  const onRemoved = (id: number): void => {
    if (id === tabId) onReset('removed')
  }

  chrome.tabs.onActivated.addListener(onActivated)
  chrome.tabs.onUpdated.addListener(onUpdated)
  chrome.tabs.onRemoved.addListener(onRemoved)

  return () => {
    chrome.tabs.onActivated.removeListener(onActivated)
    chrome.tabs.onUpdated.removeListener(onUpdated)
    chrome.tabs.onRemoved.removeListener(onRemoved)
  }
}
