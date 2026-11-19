/** Where the settings page lives in the extension's bundle. vite.config.ts
 *  registers this file as a build input, so its path does not move. */
export const SETTINGS_PATH = 'src/settings/index.html'

export const settingsUrl = (): string => chrome.runtime.getURL(SETTINGS_PATH)

/**
 * Open the settings page in a full tab, or focus it when a tab already shows
 * it: the tab and its window both come to the front, and no second tab opens.
 * A tab on one of the page's anchors or with a query still counts as open.
 */
export async function openSettingsPage(): Promise<void> {
  const url = settingsUrl()
  const open = (await chrome.tabs.query({})).find((t) => t.url !== undefined && t.url.split(/[?#]/)[0] === url)
  if (open?.id === undefined) {
    await chrome.tabs.create({ url })
    return
  }
  await chrome.tabs.update(open.id, { active: true })
  if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true })
}
