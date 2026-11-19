import { beforeEach } from 'vitest'

/**
 * Test-only. The fake `chrome` the settings page renders on: the extension's
 * local and session storage, its tabs, and the clipboard. `restart()` models a
 * browser restart the way Chrome does it: session storage is emptied, local
 * storage is kept.
 *
 * `installFakeBrowser()` registers its own beforeEach, so a test
 * file calls it once at the top level and reads the returned state.
 */
export interface FakeBrowser {
  /** chrome.storage.local, as the fake holds it. */
  local: Record<string, unknown>
  /** chrome.storage.session, as the fake holds it. */
  session: Record<string, unknown>
  /** Every text written to the clipboard, in order. */
  clipboard: string[]
  /** Every address a tab was opened on, in order. */
  opened: string[]
  restart: () => void
}

type Keys = string | string[] | Record<string, unknown> | null | undefined

function area(rows: () => Record<string, unknown>) {
  return {
    get: async (keys: Keys): Promise<Record<string, unknown>> => {
      const all = rows()
      if (keys === null || keys === undefined) return structuredClone(all)
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
      const out: Record<string, unknown> = {}
      for (const k of names) {
        if (k in all) out[k] = structuredClone(all[k])
        else if (keys !== null && typeof keys === 'object' && !Array.isArray(keys)) out[k] = keys[k]
      }
      return out
    },
    set: async (items: Record<string, unknown>): Promise<void> => {
      Object.assign(rows(), structuredClone(items))
    },
    remove: async (keys: string | string[]): Promise<void> => {
      for (const k of typeof keys === 'string' ? [keys] : keys) delete rows()[k]
    },
  }
}

export function installFakeBrowser(): FakeBrowser {
  const browser: FakeBrowser = {
    local: {}, session: {}, clipboard: [], opened: [],
    restart: () => { browser.session = {} },
  }

  beforeEach(() => {
    browser.local = {}
    browser.session = {}
    browser.clipboard = []
    browser.opened = []
    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { getURL: (p: string) => `chrome-extension://jffextensionid/${p.replace(/^\//, '')}` },
      storage: { local: area(() => browser.local), session: area(() => browser.session) },
      tabs: {
        query: async () => [],
        create: async ({ url }: { url: string }) => { browser.opened.push(url); return { id: browser.opened.length, url } },
        update: async () => undefined,
      },
      windows: { update: async () => undefined },
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { browser.clipboard.push(text) } },
    })
  })

  return browser
}
