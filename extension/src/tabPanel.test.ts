// @vitest-environment node
// The manifest import pulls in @crxjs/vite-plugin, whose esbuild refuses jsdom.
import { describe, it, expect, vi } from 'vitest'
import manifest from '../manifest.config'
import { openTabPanel, PANEL_PATH, panelPathFor, type SidePanelApi } from './tabPanel'

/** A fake of the slice of `chrome.sidePanel` the action click uses. Its calls
 *  never resolve unless a test says so: the click handler must not wait on them. */
function fakeSidePanel(): SidePanelApi & { setOptions: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> } {
  return {
    setOptions: vi.fn(() => new Promise<void>(() => {})),
    open: vi.fn(() => new Promise<void>(() => {})),
  }
}

describe('openTabPanel', () => {
  it('enables the Side panel for the clicked tab alone, with the tab id in its address, and opens it there', () => {
    const api = fakeSidePanel()

    openTabPanel(api, { id: 42 })

    expect(api.setOptions.mock.calls).toEqual([[{ tabId: 42, path: 'src/panel/index.html?tabId=42', enabled: true }]])
    expect(api.open.mock.calls).toEqual([[{ tabId: 42 }]])
  })

  it('never enables the Side panel without a tab id, which would turn it on for every tab', () => {
    const api = fakeSidePanel()

    openTabPanel(api, { id: 42 })
    openTabPanel(api, { id: 7 })

    for (const [options] of api.setOptions.mock.calls) {
      expect(typeof (options as { tabId?: unknown }).tabId).toBe('number')
    }
  })

  it('calls open in the same synchronous turn as setOptions, so the click keeps its user gesture', () => {
    // Chrome refuses open() once the gesture is gone, and awaiting setOptions
    // first loses it (docs/research/apply-by-email-facts.md, question 6).
    const api = fakeSidePanel()

    openTabPanel(api, { id: 42 })

    // Both already happened, though neither promise resolved: no await between them.
    expect(api.setOptions).toHaveBeenCalledTimes(1)
    expect(api.open).toHaveBeenCalledTimes(1)
    expect(api.setOptions.mock.invocationCallOrder[0]!).toBeLessThan(api.open.mock.invocationCallOrder[0]!)
  })

  it('does nothing for a click that carries no tab', () => {
    const api = fakeSidePanel()

    openTabPanel(api, {})

    expect(api.setOptions).not.toHaveBeenCalled()
    expect(api.open).not.toHaveBeenCalled()
  })

  it('swallows a refused call instead of leaving an unhandled rejection', async () => {
    const api = fakeSidePanel()
    api.setOptions.mockImplementation(async () => { throw new Error('No tab with id: 42') })
    api.open.mockImplementation(async () => { throw new Error('may only be called in response to a user gesture') })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      openTabPanel(api, { id: 42 })
      await new Promise((r) => setTimeout(r, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('the Side panel address', () => {
  it('is the panel page with the tab in its query', () => {
    expect(panelPathFor(9)).toBe(`${PANEL_PATH}?tabId=9`)
  })

  it('is not declared in the manifest, so no tab has a panel the action did not enable', () => {
    expect('side_panel' in manifest).toBe(false)
  })
})
