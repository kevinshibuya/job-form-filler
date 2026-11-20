import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { capForStorage, newSession, type Session } from './sessions'
import { field, installHeldMappingHost, status } from './testing/heldMapping'

/**
 * Spec #66: the Side panel belongs to the tab where it was opened. A panel
 * document reads its tab from its address and stays on it for its whole life,
 * whatever else happens in the window. Rendered whole, on the fake host port,
 * with the tab in its address as the service worker puts it there.
 */

const host = installHeldMappingHost()

type Reg = { addListener: ReturnType<typeof vi.fn> }
interface FakeChrome {
  tabs: { query: ReturnType<typeof vi.fn>; onActivated: Reg; onRemoved: Reg }
  webNavigation: { onCommitted: Reg }
  runtime: { sendMessage: ReturnType<typeof vi.fn>; onMessage: Reg; getContexts?: ReturnType<typeof vi.fn> }
  storage: { session: { set: ReturnType<typeof vi.fn> } }
}
const fake = (): FakeChrome => (globalThis as unknown as { chrome: FakeChrome }).chrome

const PANEL = 'chrome-extension://jffextensionid/src/panel/index.html'
const OTHER_POSTING = 'https://jobs.globex.com/apply'
const OTHER_STEP = 'https://jobs.globex.com/apply/step2'

/** The panel's address, as the service worker writes it, or with no tab. */
const address = (tabId: number | null): void => {
  window.history.replaceState(null, '', tabId === null ? '/?jffFakeHost=1' : `/?jffFakeHost=1&tabId=${tabId}`)
}

/** Every tab in the browser, and which one is active in the panel's window. */
const browserTabs = (ids: number[], active: number): void => {
  fake().tabs.query.mockImplementation(async (q: { active?: boolean }) =>
    (q.active === true ? [active] : ids).map((id) => ({ id, url: 'https://jobs.example.com/apply', title: `Job on tab ${id}` })))
}

/** Chrome fires an event: every listener any panel registered hears it. */
const fire = async (reg: Reg, ...args: unknown[]): Promise<void> => {
  await act(async () => {
    for (const [fn] of reg.addListener.mock.calls) (fn as (...a: unknown[]) => void)(...args)
  })
}

/** The panel binds its navigation listeners once its boot settled. */
const navListening = async (count = 1): Promise<void> => {
  await waitFor(() => { expect(fake().webNavigation.onCommitted.addListener.mock.calls.length).toBeGreaterThanOrEqual(count) })
}

const row = (tabId: number): Session | undefined => host.storage[`jff:session:${tabId}`] as Session | undefined
const sessionOn = (root: HTMLElement = document.body): string | null | undefined =>
  root.querySelector('main')?.getAttribute('data-jff-session')
/** Every tab the panel sent anything for through the service worker. */
const tabsSentFor = (): number[] =>
  fake().runtime.sendMessage.mock.calls
    .map((c) => (c[0] as { tabId?: number }).tabId)
    .filter((t): t is number => typeof t === 'number')

const scanned = async (root: HTMLElement = document.body): Promise<void> => {
  await waitFor(() => { expect(root.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done') })
}

/** The Email row's control in one panel. Two panels rendered side by side
 *  share element ids, so a label lookup could land in the other one. */
const emailBox = (root: HTMLElement = document.body): HTMLInputElement => {
  const box = root.querySelector<HTMLInputElement>('[id="f-0:0"]')
  if (box === null) throw new Error('no Email row in this panel')
  return box
}

const typeEmail = (value: string, root: HTMLElement = document.body): void => {
  fireEvent.change(emailBox(root), { target: { value } })
}

/** A parked Session for another tab, as that tab's own panel left it. */
const parkedRow = (tabId: number, createdAt: number, epoch = 1): Session =>
  capForStorage({ ...newSession(tabId, OTHER_POSTING), parked: true, createdAt, epoch })

describe('the Side panel belongs to its tab', () => {
  const setUp = (): void => {
    host.fields = [field(0, 'Email')]
    host.nothingPending = true
  }

  it("a panel bound to tab 7 keeps tab 7's Session after tab 8 is activated, and sends nothing for tab 8", async () => {
    setUp()
    address(7)
    browserTabs([7, 8], 7)
    render(<App />)
    await scanned()
    typeEmail('ada@example.com')
    await navListening()

    browserTabs([7, 8], 8)
    await fire(fake().tabs.onActivated, { tabId: 8, windowId: 1 })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    expect(sessionOn()).toBe('7')
    expect(document.querySelector('[data-jff-tab]')?.getAttribute('data-jff-tab')).toBe('7')
    expect((within(document.body).getByLabelText('Email') as HTMLInputElement).value).toBe('ada@example.com')
    expect(tabsSentFor()).not.toContain(8)
    expect(row(8)).toBeUndefined()
  })

  it("a navigation in tab 8 changes nothing in tab 7's panel, nor in tab 8's Session", async () => {
    setUp()
    address(7)
    browserTabs([7, 8], 7)
    host.storage['jff:session:8'] = capForStorage(newSession(8, OTHER_POSTING))
    render(<App />)
    await scanned()
    await navListening()
    const scansBefore = host.scans
    const before8 = row(8)

    // A step within tab 8's own site, then a detour off it: tab 7's panel
    // neither re-scans tab 8 nor parks its Session.
    await fire(fake().webNavigation.onCommitted, { tabId: 8, frameId: 0, url: OTHER_STEP })
    await fire(fake().webNavigation.onCommitted, { tabId: 8, frameId: 0, url: 'https://sso.example.org/login' })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    expect(host.scans).toBe(scansBefore)
    expect(tabsSentFor()).not.toContain(8)
    expect(row(8)).toEqual(before8)
    expect(sessionOn()).toBe('7')
    expect(status()).toBe('done')
    expect(document.querySelector('[data-jff-parked]')).toBeNull()
  })

  it("a snapshot pushed from tab 8 is not merged into tab 7's Session; tab 7's own is", async () => {
    setUp()
    address(7)
    browserTabs([7, 8], 7)
    host.storage['jff:session:8'] = capForStorage({ ...newSession(8, OTHER_POSTING), epoch: 4242 })
    render(<App />)
    await scanned()
    await waitFor(() => { expect(row(7)).toBeDefined() })
    const epoch7 = row(7)!.epoch

    // Same epoch as tab 7's scan, from tab 8: it still describes tab 8's page.
    await fire(fake().runtime.onMessage, { kind: 'snapshotPush', tabId: 8, frameId: 0, snap: { epoch: epoch7, values: { 0: 'from-8' } } })
    await fire(fake().runtime.onMessage, { kind: 'snapshotPush', tabId: 8, frameId: 0, snap: { epoch: 4242, values: { 0: 'from-8' } } })
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) })
    expect(row(7)?.snapshot).toEqual({})
    expect(row(8)?.snapshot).toEqual({})
    expect(document.body.textContent).not.toContain('from-8')

    // The control: a push from its own tab does merge.
    await fire(fake().runtime.onMessage, { kind: 'snapshotPush', tabId: 7, frameId: 0, snap: { epoch: epoch7, values: { 0: 'from-7' } } })
    await waitFor(() => { expect(row(7)?.snapshot).toEqual({ '0:0': 'from-7' }) })
  })

  it("two panels for two tabs each hold their own Session, and a write from one does not change the other's", async () => {
    setUp()
    browserTabs([7, 8], 7)
    address(7)
    const a = render(<App />).container
    await scanned(a)
    address(8)
    const b = render(<App />).container
    await scanned(b)

    typeEmail('a@example.com', a)
    typeEmail('b@example.com', b)

    await waitFor(() => { expect(row(7)?.edits['0:0']).toBe('a@example.com') })
    await waitFor(() => { expect(row(8)?.edits['0:0']).toBe('b@example.com') })
    expect(sessionOn(a)).toBe('7')
    expect(sessionOn(b)).toBe('8')
    expect(emailBox(a).value).toBe('a@example.com')
    expect(emailBox(b).value).toBe('b@example.com')

    // A second write from tab 7's panel leaves tab 8's row as it was.
    const before8 = row(8)
    typeEmail('a2@example.com', a)
    await waitFor(() => { expect(row(7)?.edits['0:0']).toBe('a2@example.com') })
    expect(row(8)).toEqual(before8)
  })

  it("with the storage full, a write from tab 7's panel does not remove tab 8's parked Session while tab 8's panel is open", async () => {
    setUp()
    address(7)
    browserTabs([7, 8, 9], 7)
    // Tab 8's panel is open; tab 9's Session is parked with no panel showing it.
    fake().runtime.getContexts = vi.fn(async () => [
      { contextType: 'SIDE_PANEL', documentUrl: `${PANEL}?tabId=7`, tabId: -1 },
      { contextType: 'SIDE_PANEL', documentUrl: `${PANEL}?tabId=8`, tabId: -1 },
    ])
    host.storage['jff:session:8'] = parkedRow(8, 1)
    host.storage['jff:session:9'] = parkedRow(9, 2)
    render(<App />)
    await scanned()
    await waitFor(() => { expect(row(7)).toBeDefined() })

    // The next write meets a full area once.
    const set = fake().storage.session.set
    const realSet = set.getMockImplementation() as (items: Record<string, unknown>) => Promise<void>
    set.mockImplementationOnce(async () => { throw new Error('QUOTA_BYTES quota exceeded') })
    typeEmail('ada@example.com')

    await waitFor(() => { expect(row(7)?.edits['0:0']).toBe('ada@example.com') })
    expect(row(8)?.parked).toBe(true)
    // Room was made from the Session no panel shows, though tab 8's is older.
    expect(row(9)).toBeUndefined()
    set.mockImplementation(realSet)
  })

  it('a panel whose open panels cannot be read removes no other Session to make room', async () => {
    setUp()
    address(7)
    browserTabs([7, 9], 7)
    fake().runtime.getContexts = vi.fn(async () => { throw new Error('getContexts is not available') })
    host.storage['jff:session:9'] = parkedRow(9, 2)
    render(<App />)
    await scanned()
    await waitFor(() => { expect(row(7)).toBeDefined() })

    fake().storage.session.set.mockImplementationOnce(async () => { throw new Error('QUOTA_BYTES quota exceeded') })
    typeEmail('ada@example.com')

    await waitFor(() => { expect(document.querySelector('[data-jff-storage-warn]')).not.toBeNull() })
    expect(row(9)?.parked).toBe(true)
  })

  it("a panel with no tab in its address shows the active tab's Session and keeps it after another tab is activated", async () => {
    setUp()
    address(null)
    browserTabs([7, 8], 7)
    render(<App />)
    await scanned()
    typeEmail('ada@example.com')
    await navListening()

    // The user moves to tab 8: the active tab is 8 from now on.
    browserTabs([7, 8], 8)
    await fire(fake().tabs.onActivated, { tabId: 8, windowId: 1 })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    expect(sessionOn()).toBe('7')
    expect((within(document.body).getByLabelText('Email') as HTMLInputElement).value).toBe('ada@example.com')
    expect(tabsSentFor()).not.toContain(8)
  })

  it('reopening the Side panel on its tab shows the Session as it was left', async () => {
    setUp()
    address(7)
    browserTabs([7], 7)
    const first = render(<App />)
    await scanned()
    typeEmail('ada@example.com')
    await waitFor(() => { expect(row(7)?.edits['0:0']).toBe('ada@example.com') })
    first.unmount()

    // The reopened panel's Scan never answers: what shows is the stored Session.
    host.holdScan = true
    render(<App />)

    await waitFor(() => { expect(sessionOn()).toBe('7') })
    expect(((await within(document.body).findByLabelText('Email')) as HTMLInputElement).value).toBe('ada@example.com')
  })
})
