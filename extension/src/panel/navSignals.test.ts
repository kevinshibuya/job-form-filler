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
    createNavSignals(1, (e) => seen.push(e))
    ;(listenerOf(events.committed) as (d: { tabId: number; frameId: number; url: string }) => void)({ tabId: 7, frameId: 3, url: 'https://a.com/step2' })
    expect(seen).toEqual([{ type: 'navigated', tabId: 7, frameId: 3, url: 'https://a.com/step2' }])
  })

  it('forwards onHistoryStateUpdated (SPA wizard steps count)', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals(1, (e) => seen.push(e))
    ;(listenerOf(events.history) as (d: { tabId: number; frameId: number; url: string }) => void)({ tabId: 7, frameId: 0, url: 'https://a.com/#/step2' })
    expect(seen).toEqual([{ type: 'navigated', tabId: 7, frameId: 0, url: 'https://a.com/#/step2' }])
  })

  it('tabs.onUpdated loading is a FALLBACK: deduped after a recent webNavigation event, forwarded otherwise', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals(1, (e) => seen.push(e))
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
    createNavSignals(1, (e) => seen.push(e))
    vi.advanceTimersByTime(NAV_FALLBACK_DEDUPE_MS + 1) // no recent webNav — dedupe is NOT what drops it
    ;(listenerOf(events.updated) as (id: number, c: { status?: string }) => void)(7, { status: 'loading' })
    expect(seen.length).toBe(0)
  })

  it('activation is filtered to the panel window; removal always forwards', () => {
    const events = installChrome()
    const seen: NavEvent[] = []
    createNavSignals(1, (e) => seen.push(e))
    ;(listenerOf(events.activated) as (info: { tabId: number; windowId: number }) => void)({ tabId: 9, windowId: 2 })
    expect(seen.length).toBe(0)
    ;(listenerOf(events.activated) as (info: { tabId: number; windowId: number }) => void)({ tabId: 9, windowId: 1 })
    expect(seen).toEqual([{ type: 'activated', tabId: 9 }])
    ;(listenerOf(events.removed) as (id: number) => void)(9)
    expect(seen[1]).toEqual({ type: 'removed', tabId: 9 })
  })

  it('the disposer removes every listener', () => {
    const events = installChrome()
    const stop = createNavSignals(1, () => {})
    stop()
    for (const e of Object.values(events)) expect(e.removeListener).toHaveBeenCalledTimes(1)
  })
})
