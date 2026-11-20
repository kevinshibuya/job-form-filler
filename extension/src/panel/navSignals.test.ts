import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNavSignals, NAV_FALLBACK_DEDUPE_MS, type NavEvent } from './navSignals'

type Listener = (...args: never[]) => void
interface FakeEvent { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> }
const ev = (): FakeEvent => ({ addListener: vi.fn(), removeListener: vi.fn() })

function installChrome(): Record<'committed' | 'history' | 'updated' | 'activated' | 'removed', FakeEvent> {
  const events = { committed: ev(), history: ev(), updated: ev(), activated: ev(), removed: ev() }
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    webNavigation: { onCommitted: events.committed, onHistoryStateUpdated: events.history },
    tabs: { onUpdated: events.updated, onActivated: events.activated, onRemoved: events.removed },
  }
  return events
}
const listenerOf = (e: FakeEvent): Listener => e.addListener.mock.calls[0]![0] as Listener

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createNavSignals (S3)', () => {
  it('forwards onCommitted with frameId + the EVENT url (never chrome.tabs.Tab)', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals((e) => seen.push(e))
    ;(listenerOf(events.committed) as (d: { tabId: number; frameId: number; url: string }) => void)({ tabId: 7, frameId: 3, url: 'https://a.com/step2' })
    expect(seen).toEqual([{ type: 'navigated', tabId: 7, frameId: 3, url: 'https://a.com/step2' }])
  })

  it('forwards onHistoryStateUpdated (SPA wizard steps count)', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals((e) => seen.push(e))
    ;(listenerOf(events.history) as (d: { tabId: number; frameId: number; url: string }) => void)({ tabId: 7, frameId: 0, url: 'https://a.com/#/step2' })
    expect(seen).toEqual([{ type: 'navigated', tabId: 7, frameId: 0, url: 'https://a.com/#/step2' }])
  })

  it('tabs.onUpdated loading is a FALLBACK: deduped after a recent webNavigation event, forwarded otherwise', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals((e) => seen.push(e))
    ;(listenerOf(events.committed) as (d: { tabId: number; frameId: number; url: string }) => void)({ tabId: 7, frameId: 0, url: 'https://a.com' })
    ;(listenerOf(events.updated) as (id: number, c: { status?: string; url?: string }) => void)(7, { status: 'loading', url: 'https://a.com/x' })
    expect(seen.length).toBe(1) // deduped
    vi.advanceTimersByTime(NAV_FALLBACK_DEDUPE_MS + 1)
    ;(listenerOf(events.updated) as (id: number, c: { status?: string; url?: string }) => void)(7, { status: 'loading', url: 'https://b.com' })
    expect(seen[1]).toEqual({ type: 'navigated', tabId: 7, frameId: 0, url: 'https://b.com' })
    ;(listenerOf(events.updated) as (id: number, c: { status?: string; url?: string }) => void)(7, { status: 'complete' })
    expect(seen.length).toBe(2) // non-loading updates are noise
  })

  it('a loading tick WITHOUT a url emits NOTHING — Chrome omits url unless it changed, and an empty url would misread as a cross-site move', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals((e) => seen.push(e))
    vi.advanceTimersByTime(NAV_FALLBACK_DEDUPE_MS + 1) // no recent webNav — dedupe is NOT what drops it
    ;(listenerOf(events.updated) as (id: number, c: { status?: string }) => void)(7, { status: 'loading' })
    expect(seen.length).toBe(0)
  })

  it('never listens to tab activation: a panel follows no other tab; removal forwards', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals((e) => seen.push(e))
    expect(events.activated.addListener).not.toHaveBeenCalled()
    ;(listenerOf(events.removed) as (id: number) => void)(9)
    expect(seen).toEqual([{ type: 'removed', tabId: 9 }])
  })

  it('a removal drops the tab from the dedupe map (F11: it grew one entry per tab, forever)', () => {
    // The map is private, so its emptiness is probed the only way it is
    // observable: the dedupe window is what an entry BUYS, and after the
    // removal a tick inside that window is no longer suppressed. `removed` is
    // not otherwise a signal this module reacts to, so without the delete the
    // entry survives for the whole life of the panel.
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals((e) => seen.push(e))
    ;(listenerOf(events.committed) as (d: { tabId: number; frameId: number; url: string }) => void)({ tabId: 7, frameId: 0, url: 'https://a.com' })
    ;(listenerOf(events.removed) as (id: number) => void)(7)
    ;(listenerOf(events.updated) as (id: number, c: { status?: string; url?: string }) => void)(7, { status: 'loading', url: 'https://a.com/x' })
    expect(seen.map((e) => e.type)).toEqual(['navigated', 'removed', 'navigated'])
  })

  it('the disposer removes every listener', () => {
    const events = installChrome()
    const stop = createNavSignals(() => {})
    stop()
    for (const [name, e] of Object.entries(events)) {
      expect(e.removeListener).toHaveBeenCalledTimes(name === 'activated' ? 0 : 1)
    }
  })
})
