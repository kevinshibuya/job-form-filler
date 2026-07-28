import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTabScope } from './tabScope'

type Listener = (...args: unknown[]) => void
const activated: Listener[] = []
const updated: Listener[] = []
const removed: Listener[] = []

beforeEach(() => {
  activated.length = 0; updated.length = 0; removed.length = 0
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      onActivated: { addListener: (l: Listener) => activated.push(l), removeListener: () => undefined },
      onUpdated: { addListener: (l: Listener) => updated.push(l), removeListener: () => undefined },
      onRemoved: { addListener: (l: Listener) => removed.push(l), removeListener: () => undefined },
    },
  }
})

describe('createTabScope', () => {
  it('resets with reason=activated when the user activates a different tab', () => {
    const onReset = vi.fn()
    createTabScope(7, onReset)
    activated[0]!({ tabId: 9 })
    expect(onReset).toHaveBeenCalledExactlyOnceWith('activated')
  })

  it('does NOT reset when the bound tab is re-activated', () => {
    const onReset = vi.fn()
    createTabScope(7, onReset)
    activated[0]!({ tabId: 7 })
    expect(onReset).not.toHaveBeenCalled()
  })

  it('resets with reason=navigated when the bound tab starts navigating (a wizard step is new DOM)', () => {
    const onReset = vi.fn()
    createTabScope(7, onReset)
    updated[0]!(7, { status: 'loading' })
    expect(onReset).toHaveBeenCalledExactlyOnceWith('navigated')
  })

  it('ignores navigation in an unrelated tab', () => {
    const onReset = vi.fn()
    createTabScope(7, onReset)
    updated[0]!(9, { status: 'loading' })
    expect(onReset).not.toHaveBeenCalled()
  })

  it('ignores non-loading updates such as a favicon change', () => {
    const onReset = vi.fn()
    createTabScope(7, onReset)
    updated[0]!(7, { favIconUrl: 'x' })
    expect(onReset).not.toHaveBeenCalled()
  })

  it('resets with reason=removed when the bound tab is closed', () => {
    const onReset = vi.fn()
    createTabScope(7, onReset)
    removed[0]!(7)
    // `removed` must be distinguishable: re-scanning a closed tab is guaranteed to
    // throw on chrome.tabs.get, and re-scanning on a mere tab SWITCH would spend a
    // batched `claude -p` call per switch.
    expect(onReset).toHaveBeenCalledExactlyOnceWith('removed')
  })
})
