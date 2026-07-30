import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { EnumField, HostResponse, Resolution } from '@jff/shared'
import { App, hostnameOf } from './App'
import { clearResume, saveResume } from './resume'
import { capForStorage, newSession, type Session } from './sessions'

/** The fake port forwards to `window.__jffHostBridge` when one is installed, so
 *  this is how a test gives the panel real resolutions (the canned fake answers
 *  every resolve with zero) or a host that never answers at all. */
function installHostBridge(answer: (method: string) => Promise<unknown>): void {
  window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> =>
    ({ requestId, ok: true, result: method === 'profile.get' ? ONBOARDED : await answer(method) })
}

const SELF_CHECK = {
  node: { ok: true, version: 'v20.0.0' },
  claude: { ok: true, path: '(fake)', detail: 'found' },
  auth: { ok: true, detail: 'logged in' },
  db: { ok: true, path: '(fake)' },
}

/** O3: the default test persona is ONBOARDED. Gate tests opt out explicitly. */
const ONBOARDED = { email: 'fake@example.com', phone: '+1 555 0100', fullName: 'Fake User' }

/**
 * jsdom's Blob has no `arrayBuffer()`, so `saveResume(new File(...))` throws here
 * (same shim, same reasoning as resume.test.ts — Chrome has had it since 76, so
 * production is untouched and the `typeof` guard makes this inert in a real browser).
 */
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.onerror = () => reject(reader.error)
        reader.readAsArrayBuffer(this)
      })
    },
  })
}

/** The backing object of the stateful `chrome.storage.session` fake: the session
 *  store reads and writes real rows through it, so a test can seed storage before
 *  a mount and inspect what the panel persisted afterwards. Each test gets a
 *  FRESH object which the fake closes over BY VALUE — a scan leaked from an
 *  earlier test keeps writing into its own (now unobserved) rows instead of
 *  resurrecting a row the current test just deleted. */
let sessionRows: Record<string, unknown> = {}
const storageRows = (): Record<string, unknown> => sessionRows

const statefulSessionArea = (rows: Record<string, unknown>) => ({
  get: vi.fn(async (keys: string | string[] | null) => {
    if (keys === null || keys === undefined) return { ...rows }
    const wanted = typeof keys === 'string' ? [keys] : keys
    const out: Record<string, unknown> = {}
    for (const k of wanted) { if (k in rows) out[k] = rows[k] }
    return out
  }),
  set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(rows, items) }),
  remove: vi.fn(async (keys: string | string[]) => {
    for (const k of (typeof keys === 'string' ? [keys] : keys)) delete rows[k]
  }),
})

/** Fire a listener the panel registered on a chrome event, waiting for the
 *  registration first — the panel binds its navigation signals only after the
 *  mount's rehydrate+prune resolves. */
async function firstListener<T>(reg: { addListener: ReturnType<typeof vi.fn> }): Promise<T> {
  await waitFor(() => { expect(reg.addListener.mock.calls.length).toBeGreaterThan(0) })
  return reg.addListener.mock.calls[0]![0] as T
}

const chromeFake = () => (globalThis as unknown as {
  chrome: {
    tabs: {
      get: ReturnType<typeof vi.fn>
      query: ReturnType<typeof vi.fn>
      onActivated: { addListener: ReturnType<typeof vi.fn> }
      onUpdated: { addListener: ReturnType<typeof vi.fn> }
      onRemoved: { addListener: ReturnType<typeof vi.fn> }
    }
    webNavigation: {
      onCommitted: { addListener: ReturnType<typeof vi.fn> }
      onHistoryStateUpdated: { addListener: ReturnType<typeof vi.fn> }
    }
    runtime: { sendMessage: ReturnType<typeof vi.fn> }
  }
}).chrome

/** Chrome commits a navigation in the given frame of the given tab. */
const commit = async (tabId: number, url: string, frameId = 0): Promise<void> => {
  const fn = await firstListener<(d: { tabId: number; frameId: number; url: string }) => void>(
    chromeFake().webNavigation.onCommitted)
  await act(async () => { fn({ tabId, frameId, url }) })
}

/** A tab in the panel's window (id 1, per chrome.windows.getCurrent) became active. */
const activate = async (tabId: number, windowId = 1): Promise<void> => {
  const fn = await firstListener<(info: { tabId: number; windowId: number }) => void>(
    chromeFake().tabs.onActivated)
  await act(async () => { fn({ tabId, windowId }) })
}

const closeTab = async (tabId: number): Promise<void> => {
  const fn = await firstListener<(id: number) => void>(chromeFake().tabs.onRemoved)
  await act(async () => { fn(tabId) })
}

afterEach(async () => {
  delete window.__jffHostBridge
  await clearResume()
})

beforeEach(async () => {
  // The compile-time seam is on in tests (vitest define), so the fake host answers.
  window.history.replaceState(null, '', '/?jffFakeHost=1')
  sessionRows = {}
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: 'https://jobs.acme.com/apply', title: 'Engineer at Acme' }]),
      get: vi.fn(async () => ({ id: 7, url: 'https://jobs.acme.com/apply', title: 'Engineer at Acme' })),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn(async (msg: { kind?: string; message?: { type?: string } }) => {
        if (msg?.kind === 'inject') return { ok: true, frames: [0] }
        if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
          return {
            ok: true,
            replies: [{
              frameId: 0, url: 'https://jobs.acme.com/apply',
              payload: { ok: true, scan: { epoch: 1, fields: [{ frameId: -1, fid: 0, epoch: 1, label: 'Email', name: 'email', idAttr: null, kind: 'text', options: [], required: false, visible: true, currentValue: null, demographic: false }], unreachableWidgets: 0, activeCaptcha: false } },
            }],
            failures: [],
          }
        }
        if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') {
          return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        }
        if (msg?.kind === 'toContent') return { ok: true, replies: [], failures: [] }
        return { ok: true }
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    // STATEFUL: the session store persists real rows here, and onScan sweeps
    // this tab's stale snapshot keys out of the same area.
    storage: { session: statefulSessionArea(sessionRows) },
  }
  // O3: a stored resume is half of the completeness gate; the default persona
  // has one. Gate tests call clearResume() explicitly.
  await saveResume(new File(['stub resume'], 'cv.txt', { type: 'text/plain' }))
})

describe('hostnameOf', () => {
  // Regression: the previous `tab.url === undefined ? '' : new URL(tab.url).hostname`
  // threw on '' — the value Chrome reports for a tab that has not committed a
  // navigation. Thrown out of the auto-scan effect it killed the scan and logged a
  // console error, which the foundation smoke's zero-console-errors rule caught
  // intermittently.
  it('returns no hostname for a tab that has not committed a navigation', () => {
    expect(hostnameOf('')).toBe('')
    expect(hostnameOf(undefined)).toBe('')
  })

  it('returns no hostname for an unparseable url instead of throwing', () => {
    expect(hostnameOf('not a url')).toBe('')
  })

  it('still reads the hostname of a real url', () => {
    expect(hostnameOf('https://jobs.acme.com/apply')).toBe('jobs.acme.com')
  })
})

describe('App', () => {
  it('mounts the full review surface against the fake host', async () => {
    render(<App />)
    expect(await screen.findByText(/Host ready/)).toBeTruthy()
    expect(await screen.findByRole('button', { name: /^Scan(ning…)?$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save answers' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pick job description' })).toBeTruthy()
    // The auto-scan guessed the company from the stubbed tab title.
    expect(await screen.findByDisplayValue('Acme')).toBeTruthy()
  })

  it('unlocks the facts editor only once the host has answered', async () => {
    // The host DELETES a key written as '' (Task 5 writeKv), so a Save on a
    // not-yet-loaded editor would wipe the whole profile. ProfileEditor.test.tsx
    // proves the disabled state; this proves App actually wires `loaded` to the
    // profile.get/answerBank.get round-trip instead of hard-coding true.
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit your facts' }))
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Save facts' }) as HTMLButtonElement).disabled).toBe(false)
    })
  })
})

describe('App scan status', () => {
  const scanReply = {
    ok: true,
    replies: [{
      frameId: 0, url: 'https://jobs.acme.com/apply',
      payload: { ok: true, scan: { epoch: 1, fields: [{ frameId: -1, fid: 0, epoch: 1, label: 'Email', name: 'email', idAttr: null, kind: 'text', options: [], required: false, visible: true, currentValue: null, demographic: false }], unreachableWidgets: 0, activeCaptcha: false } },
    }],
    failures: [],
  }

  it('reaches done after the auto-scan when the page has fields', async () => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReply
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done')
    })
    // fake host resolve returns zero resolutions; the copy reflects that honestly
    expect(screen.getByText('✓ 0 filled, 0 already on page, 0 proposed, 0 need input')).toBeTruthy()
  })

  it('reaches empty (after the one-shot retry) when no frame has fields', async () => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent') return { ok: true, replies: [], failures: [] }
      return { ok: true }
    })
    render(<App />)
    // The retry's 1.5s sleep is a REAL timer here (App injects the real sleep);
    // vitest.config.ts documents ~10x jsdom inflation under contention, so the
    // budget is wide.
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('empty')
    }, { timeout: 8_000 })
  }, 15_000)

  it('surfaces an inject failure as a failed status instead of a silent no-op', async () => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string }) => {
      if (msg?.kind === 'inject') return { ok: false, error: 'Cannot access contents of the page' }
      return { ok: true, replies: [], failures: [] }
    })
    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('failed')
    })
    // getAllByText, not getByText: the reason appears TWICE by design — once in
    // the status line and once in the synthetic relay diagnostics row below it.
    // getAll* still throws when nothing surfaces the reason, so this keeps teeth.
    expect(screen.getAllByText(/Cannot access contents of the page/).length).toBeGreaterThan(0)
    // The synthetic relay report makes the diagnostics disclosure render even
    // though no frame ever replied.
    expect(document.querySelector('[data-jff-diagnostics]')).not.toBeNull()
  })

  it('surfaces a broadcast relay failure (inject fine, toContent dead) as failed', async () => {
    // Guards the sendToTab ok-check specifically: inject succeeds, so only the
    // broadcast guard can produce the failed status here.
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent') return { ok: false, error: 'relay exploded' }
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('failed')
    })
    expect(screen.getAllByText(/relay exploded/).length).toBeGreaterThan(0)
  })

  it('disables the Scan button and relabels it while a scan runs', async () => {
    // ONE-SHOT latch: only the FIRST inject hangs. A latch that returned a fresh
    // pending promise every time would deadlock the 0-field retry's second inject
    // and the scan would never settle.
    let release: (() => void) | null = null
    let injected = false
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    const base = send.getMockImplementation()!
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject' && !injected) {
        injected = true
        return new Promise((r) => { release = () => r({ ok: true, frames: [0] }) })
      }
      return base(msg) // default: inject ok + one-field scan reply, so no retry runs
    })
    render(<App />)
    const btn = await screen.findByRole('button', { name: 'Scanning…' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    release!()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scan' })).toBeTruthy(), { timeout: 4_000 })
  }, 10_000)

  it('counts DISTINCT frames in the empty status, not raw report rows', async () => {
    // Frame 0 errors on the first pass and answers (with nothing) on the retry:
    // two report rows, ONE frame on the page.
    let scans = 0
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        scans++
        return scans === 1
          ? { ok: true, replies: [{ frameId: 0, url: 'https://jobs.acme.com/apply', payload: { ok: false, error: 'bad_scan' } }], failures: [] }
          : { ok: true, replies: [{ frameId: 0, url: 'https://jobs.acme.com/apply', payload: { ok: true, scan: { epoch: 1, fields: [], unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
      }
      return { ok: true, replies: [], failures: [] }
    })
    render(<App />)
    // Real 1.5s retry timer, same widened budget as the empty-state test above.
    expect(await screen.findByText(/Scanned 1 frames, found no form fields/, undefined, { timeout: 8_000 })).toBeTruthy()
  }, 15_000)

  it('keeps the enumeration evidence when the scan dies after enumerating', async () => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReply
      if (msg?.kind === 'toContent') return { ok: false, error: 'relay died after the scan' }
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('failed')
    })
    // Both rows: what the frame DID report, and the relay failure that ended it.
    const diagnostics = document.querySelector('[data-jff-diagnostics]')?.textContent ?? ''
    expect(diagnostics).toContain('frame 0')
    expect(diagnostics).toContain('1 fields')
    expect(diagnostics).toContain('relay')
    expect(diagnostics).toContain('relay died after the scan')
  })

  it('scans anyway when the host connects but never answers the self-check', async () => {
    // A wedged host must not pin the panel on 'connecting' forever.
    installHostBridge(async (method) => {
      if (method === 'selfCheck') return await new Promise(() => undefined) // never answers
      if (method === 'selector.get') return { selector: null }
      if (method === 'resolve') return { epoch: 1, resolutions: [], llmError: null }
      return {}
    })
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReply
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      return { ok: true }
    })
    render(<App hostWaitMs={400} />)
    // The panel parks on 'connecting' first — and then goes ahead on its own.
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('connecting')
    })
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done')
    }, { timeout: 5_000 })
  }, 10_000)

  it('shows the busy label before the first await of a scan', async () => {
    // tabs.get is the FIRST await in onScan: hanging it proves the button flipped
    // synchronously with the re-entry guard rather than after two round-trips.
    const tabs = (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } }).chrome.tabs
    tabs.get.mockImplementation(async () => await new Promise(() => undefined))
    render(<App />)
    expect(((await screen.findByRole('button', { name: 'Scanning…' })) as HTMLButtonElement).disabled).toBe(true)
  })

  it('releases the scan guard when the bound tab is already gone', async () => {
    // The tab-closed early return must go through the finally: otherwise the
    // panel is wedged and every later Scan click is a silent no-op.
    let gone = true
    const tabs = (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } }).chrome.tabs
    tabs.get.mockImplementation(async () => {
      // The delay makes the busy render observable, so the click below is ordered
      // AFTER the auto-scan's early return instead of racing it.
      if (gone) { await new Promise((r) => setTimeout(r, 20)); throw new Error('No tab with id: 7') }
      return { id: 7, url: 'https://jobs.acme.com/apply', title: 'Engineer at Acme' }
    })
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReply
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      return { ok: true }
    })
    render(<App />)
    await screen.findByRole('button', { name: 'Scanning…' }) // the auto-scan started
    // Back to idle: the early return went through the finally.
    const btn = await screen.findByRole('button', { name: 'Scan' })
    gone = false
    fireEvent.click(btn)
    // …and the re-entry guard was released too, so this second scan really runs.
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done')
    }, { timeout: 5_000 })
  }, 10_000)

  it('shows Saving… while the save round-trip is in flight', async () => {
    let release: (() => void) | null = null
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      // The mount auto-scan is incidental here, but it MUST enumerate something:
      // an empty first pass puts runScan on its one-shot retry, whose 1.5s
      // `sleep` is a bare setTimeout with no unmount linkage. This test asserts
      // only on the Save button and returns in ~1ms, so that retry outlived the
      // test and fired `inject` + JFF_SCAN into a LATER test's fresh
      // chrome.runtime.sendMessage mock — the O1/O3 gate test counts scans on
      // that global mock, so it failed ~1 run in 3 depending on how far the
      // 1.5s drift carried.
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReply
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SNAPSHOT') {
        return new Promise((r) => { release = () => r({ ok: true, replies: [], failures: [] }) })
      }
      return { ok: true, replies: [], failures: [] }
    })
    render(<App />)
    await screen.findByText(/Host ready/)
    fireEvent.click(screen.getByRole('button', { name: 'Save answers' }))
    expect(((await screen.findByRole('button', { name: 'Saving…' })) as HTMLButtonElement).disabled).toBe(true)
    release!()
    await screen.findByRole('button', { name: 'Save answers' })
    // Regression lock for the leak above: this test must leave NO scan in
    // flight. A settled status is only reachable within the default waitFor
    // budget when the first enumeration found fields; restore the empty
    // JFF_SCAN reply and the panel is still on 'retrying' here (it settles only
    // after the 1.5s retry), so the leak fails HERE, deterministically, instead
    // of surfacing as a 1-in-3 flake forty tests downstream.
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done')
    })
  })
})

describe('App mid-scan navigation', () => {
  const statusNow = (): string | null | undefined =>
    document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')

  const scanReplyFor = (label: string) => ({
    ok: true,
    replies: [{
      frameId: 0, url: 'https://jobs.acme.com/apply',
      payload: { ok: true, scan: { epoch: 1, fields: [{ frameId: -1, fid: 0, epoch: 1, label, name: 'q', idAttr: null, kind: 'text', options: [], required: false, visible: true, currentValue: null, demographic: false }], unreachableWidgets: 0, activeCaptcha: false } },
    }],
    failures: [],
  })

  /** Harness adaptation (Task 14): navigation truth is webNavigation, and the
   *  event carries the url. A SAME-SITE step keeps the session and re-scans —
   *  a cross-site url would PARK it, which is a different behaviour entirely. */
  const navigateBoundTab = async (url = 'https://jobs.acme.com/apply/step2'): Promise<void> => {
    await commit(7, url)
  }

  beforeEach(() => {
    // A resolution is required for the field to render as a row at all.
    installHostBridge(async (method) => {
      if (method === 'selfCheck') return SELF_CHECK
      if (method === 'selector.get') return { selector: null }
      if (method === 'resolve') {
        const resolutions: Resolution[] = [
          { handle: { frameId: 0, fid: 0, epoch: 1 }, tier: 'needs_input', value: '', source: null, key: null, answerId: null, reason: 'unknown' },
        ]
        return { epoch: 1, resolutions, llmError: null }
      }
      return {}
    })
  })

  it('drops the results of a scan whose page navigated away mid-flight', async () => {
    // A resolve can take minutes, so a scan routinely outlives its page. Writing
    // its fields/status back after the navigation showed a filled form for a page
    // that no longer exists (its JFF_FILLs were all answered stale_epoch).
    let releaseFirstScan: (() => void) | null = null
    let scans = 0
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        scans++
        // The SECOND scan (the one for the new page) parks forever: while it is in
        // flight the panel must be showing nothing at all from the dead page.
        if (scans > 1) return await new Promise(() => undefined)
        return await new Promise((r) => { releaseFirstScan = () => r(scanReplyFor('Dead page field')) })
      }
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => { expect(releaseFirstScan).not.toBeNull() })
    await navigateBoundTab()
    releaseFirstScan!()
    await waitFor(() => { expect(scans).toBe(2) })
    await waitFor(() => { expect(statusNow()).toBe('enumerating') })
    // Nothing the dead scan produced reached the screen: no row, no ✓ N filled.
    expect(screen.queryByText('Dead page field')).toBeNull()
    expect(document.querySelector('[data-jff-rows]')).toBeNull()
    expect(statusNow()).not.toBe('done')
  })

  it('replays a navigation trigger the scan guard swallowed', async () => {
    // The navigation's own auto-scan trigger hits `scanningRef` and returns; without
    // the replay the new page is never scanned and the panel just sits empty.
    let releaseFirstScan: (() => void) | null = null
    let scans = 0
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        scans++
        if (scans > 1) return scanReplyFor('Live page field')
        return await new Promise((r) => { releaseFirstScan = () => r(scanReplyFor('Dead page field')) })
      }
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => { expect(releaseFirstScan).not.toBeNull() })
    await navigateBoundTab()
    releaseFirstScan!()
    await waitFor(() => { expect(scans).toBe(2) })
    await waitFor(() => { expect(statusNow()).toBe('done') })
    // The new page's fields, and the nonce the replay spent to get them.
    expect(await screen.findByText('Live page field')).toBeTruthy()
    expect(screen.queryByText('Dead page field')).toBeNull()
    expect(document.querySelector('[data-jff-scans]')?.getAttribute('data-jff-scans')).toBe('2')
  })
})

describe('App generation discipline', () => {
  const statusNow = (): string | null | undefined =>
    document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')
  const companyInput = (): HTMLInputElement =>
    document.querySelector('[data-jff-company] input') as HTMLInputElement
  const sendMock = () => (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
  const tabsGet = () => (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } }).chrome.tabs.get

  const ACME = { id: 7, url: 'https://jobs.acme.com/apply', title: 'Engineer at Acme' }
  const GLOBEX = { id: 7, url: 'https://jobs.globex.com/apply', title: 'Engineer at Globex' }

  const enumField = (fid: number, label: string) => ({
    frameId: -1, fid, epoch: 1, label, name: null, idAttr: null, kind: 'text',
    options: [], required: false, visible: true, currentValue: null, demographic: false,
  })
  const scanReplyFor = ([proposed, needsInput]: [string, string]) => ({
    ok: true,
    replies: [{
      frameId: 0, url: 'https://jobs.acme.com/apply',
      payload: { ok: true, scan: { epoch: 1, fields: [enumField(0, proposed), enumField(1, needsInput)], unreachableWidgets: 0, activeCaptcha: false } },
    }],
    failures: [],
  })
  const jobTextReply = { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
  const fillRefused = {
    ok: true,
    replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [{ handle: { frameId: 0, fid: 0, epoch: 1 }, reason: 'no-matching-option' }] } } }],
    failures: [],
  }
  const fillAccepted = {
    ok: true,
    replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [{ handle: { frameId: 0, fid: 1, epoch: 1 }, committed: null }], failed: [] } } }],
    failures: [],
  }

  /** inject + a two-field enumeration + no job text: a scan that settles `done`. */
  const installFullScan = (labelsFor: (nth: number) => [string, string] = () => ['Work model', 'Why us?']): void => {
    let scans = 0
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') { scans++; return scanReplyFor(labelsFor(scans)) }
      if (msg?.kind === 'toContent') return jobTextReply
      return { ok: true }
    })
  }

  /** tabs.get answers once and then hangs, so the REPLAYED scan parks on its very
   *  first await. Anything on the status line afterwards can only be the dead
   *  scan's own write — without this the replay's `injecting` masks the leak. */
  const parkReplayedScan = (): void => {
    let calls = 0
    tabsGet().mockImplementation(async () => {
      calls++
      if (calls > 1) return await new Promise(() => undefined)
      return ACME
    })
  }

  /** Harness adaptation (Task 14): a SAME-SITE webNavigation commit — the event
   *  that keeps the session and re-scans. */
  const navigateBoundTab = async (url = 'https://jobs.acme.com/apply/step2'): Promise<void> => {
    await commit(7, url)
  }

  beforeEach(() => {
    installHostBridge(async (method) => {
      if (method === 'selfCheck') return SELF_CHECK
      if (method === 'selector.get') return { selector: null }
      if (method === 'resolve') {
        const resolutions: Resolution[] = [
          { handle: { frameId: 0, fid: 0, epoch: 1 }, tier: 'proposed', value: 'Proposed answer', source: 'llm_key', key: 'salary', answerId: null, reason: 'llm' },
          { handle: { frameId: 0, fid: 1, epoch: 1 }, tier: 'needs_input', value: 'My drafted answer', source: null, key: null, answerId: null, reason: 'unknown' },
        ]
        return { epoch: 1, resolutions, llmError: null }
      }
      return {}
    })
  })

  it('says the page changed while the invalidated scan is still draining', async () => {
    // The dead scan's resolve cannot be cancelled (deferred host-protocol change),
    // so a blank status line here is minutes of a frozen-looking panel.
    let releaseScan: (() => void) | null = null
    let scans = 0
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        scans++
        if (scans > 1) return scanReplyFor(['Work model', 'Why us?'])
        return await new Promise((r) => { releaseScan = () => r(scanReplyFor(['Dead work model', 'Dead why us?'])) })
      }
      if (msg?.kind === 'toContent') return jobTextReply
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => { expect(releaseScan).not.toBeNull() })
    await navigateBoundTab()
    expect(statusNow()).toBe('superseded')
    expect(screen.getByText('Page changed — finishing the old scan before rescanning…')).toBeTruthy()
    releaseScan!()
    // The replayed scan's own progress takes the line back over.
    await waitFor(() => { expect(statusNow()).toBe('done') })
    expect(screen.queryByText('Dead work model')).toBeNull()
  })

  it('clears a lingering superseded status when the navigation replay finds no tab', async () => {
    // A navigate-then-close race: 'navigated' sets 'superseded' and queues the
    // replay, but by the time the replay's own getTab() runs the tab is gone — the
    // replay itself, not another reset, must clear the promise of a rescan.
    let releaseScan: (() => void) | null = null
    let calls = 0
    tabsGet().mockImplementation(async () => {
      calls++
      if (calls > 1) throw new Error('No tab with id: 7')
      return ACME
    })
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        return await new Promise((r) => { releaseScan = () => r(scanReplyFor(['Dead work model', 'Dead why us?'])) })
      }
      if (msg?.kind === 'toContent') return jobTextReply
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => { expect(releaseScan).not.toBeNull() })
    await navigateBoundTab()
    expect(statusNow()).toBe('superseded')
    releaseScan!()
    await waitFor(() => { expect(statusNow()).toBeUndefined() })
  })

  it('drops a dead scan progress event instead of resurrecting its status', async () => {
    // Pins the onProgress generation guard: without it the dead scan's `resolving`
    // phase overwrites `superseded` with a phase of a page that is gone.
    let releaseJobText: (() => void) | null = null
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReplyFor(['Work model', 'Why us?'])
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') {
        return await new Promise((r) => { releaseJobText = () => r(jobTextReply) })
      }
      return { ok: true, replies: [], failures: [] }
    })
    parkReplayedScan()
    render(<App />)
    await waitFor(() => { expect(releaseJobText).not.toBeNull() })
    await navigateBoundTab()
    releaseJobText!()
    // The dead scan ran to completion: its replay reached the parked tabs.get.
    await waitFor(() => { expect(tabsGet().mock.calls.length).toBeGreaterThan(1) })
    expect(statusNow()).toBe('superseded')
  })

  it('drops a dead scan failure instead of blaming the new page for it', async () => {
    // Pins the catch-path generation guard.
    let failScan: (() => void) | null = null
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        return await new Promise((r) => { failScan = () => r({ ok: false, error: 'relay died on the dead page' }) })
      }
      return { ok: true, replies: [], failures: [] }
    })
    parkReplayedScan()
    render(<App />)
    await waitFor(() => { expect(failScan).not.toBeNull() })
    await navigateBoundTab()
    failScan!()
    await waitFor(() => { expect(tabsGet().mock.calls.length).toBeGreaterThan(1) })
    expect(statusNow()).toBe('superseded')
    expect(screen.queryByText(/relay died on the dead page/)).toBeNull()
  })

  it.each([
    { label: 'Accept', button: 'Accept', msgType: 'JFF_FILL', reply: fillRefused, failureText: /Accept failed/ },
    { label: 'Fill', button: 'Fill', msgType: 'JFF_FILL', reply: fillRefused, failureText: /Fill failed/ },
    { label: 'Pick', button: 'Pick job description', msgType: 'JFF_PICK', reply: { ok: false, error: 'relay died on the dead page' }, failureText: /Pick failed/ },
  ])('keeps a dead page $label failure off the new page status line', async ({ button, msgType, reply, failureText }) => {
    let release: (() => void) | null = null
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReplyFor(['Work model', 'Why us?'])
      if (msg?.kind === 'toContent' && msg.message?.type === msgType) {
        return await new Promise((r) => { release = () => r(reply) })
      }
      if (msg?.kind === 'toContent') return jobTextReply
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => { expect(statusNow()).toBe('done') })
    fireEvent.click(screen.getByRole('button', { name: button }))
    await waitFor(() => { expect(release).not.toBeNull() })
    await navigateBoundTab()
    // The new page scans and settles while the dead page's request is still out.
    await waitFor(() => { expect(statusNow()).toBe('done') })
    release!()
    // acting/picking clears in the handler's finally, i.e. after its guarded write.
    await waitFor(() => { expect((screen.getByRole('button', { name: button }) as HTMLButtonElement).disabled).toBe(false) })
    expect(statusNow()).toBe('done')
    expect(screen.queryByText(failureText)).toBeNull()
  })

  it('does not badge the new page field with a dead page fill', async () => {
    // A ref is `frameId:fid` with no epoch, so the new page's field 0:1 would wear
    // the dead page's "on the page" badge although nothing was filled on it.
    let releaseFill: (() => void) | null = null
    let scans = 0
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        scans++
        return scanReplyFor(scans === 1 ? ['Work model', 'Why us?'] : ['New work model', 'Why this employer?'])
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL') {
        return await new Promise((r) => { releaseFill = () => r(fillAccepted) })
      }
      if (msg?.kind === 'toContent') return jobTextReply
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => { expect(statusNow()).toBe('done') })
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }))
    await waitFor(() => { expect(releaseFill).not.toBeNull() })
    await navigateBoundTab()
    expect(await screen.findByText('Why this employer?')).toBeTruthy()
    releaseFill!()
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Fill' })).toBeTruthy() })
    expect(screen.queryByText('on the page')).toBeNull()
  })

  it('does not promote the new page row when a dead page Accept succeeds late', async () => {
    let releaseFill: (() => void) | null = null
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReplyFor(['Work model', 'Why us?'])
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL') {
        return await new Promise((r) => { releaseFill = () => r({ ok: true, replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [{ handle: { frameId: 0, fid: 0, epoch: 1 }, committed: null }], failed: [] } } }], failures: [] }) })
      }
      if (msg?.kind === 'toContent') return jobTextReply
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => { expect(statusNow()).toBe('done') })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(releaseFill).not.toBeNull() })
    await navigateBoundTab()
    await waitFor(() => { expect(statusNow()).toBe('done') })
    releaseFill!()
    await waitFor(() => { expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(false) })
    // Still Proposed: the fill the promotion claims happened was answered by a page
    // that no longer exists.
    expect(document.querySelector('li[data-jff-tier="proposed"]')).not.toBeNull()
    expect(document.querySelector('li[data-jff-tier="auto"]')).toBeNull()
  })

  it('does not paste a dead page job description into the new page', async () => {
    let releasePick: (() => void) | null = null
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReplyFor(['Work model', 'Why us?'])
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_PICK') {
        return await new Promise((r) => { releasePick = () => r({ ok: true, replies: [{ frameId: 0, payload: { ok: true, pick: { selector: '#jd', text: 'Dead page job description' } } }], failures: [] }) })
      }
      if (msg?.kind === 'toContent') return jobTextReply
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => { expect(statusNow()).toBe('done') })
    fireEvent.click(screen.getByRole('button', { name: 'Pick job description' }))
    await waitFor(() => { expect(releasePick).not.toBeNull() })
    await navigateBoundTab()
    await waitFor(() => { expect(statusNow()).toBe('done') })
    releasePick!()
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Pick job description' })).toBeTruthy() })
    expect((document.querySelector('[data-jff-paste] textarea') as HTMLTextAreaElement).value).toBe('')
  })

  it('does not learn a poisoned selector when a navigation lands mid-getTab in a pick', async () => {
    // The pick itself already answered when the navigation lands — only the
    // SECOND await (getTab, read for the hostname) is still in flight. Without its
    // own guard, the old page's selector would be saved under the new hostname.
    let selectorSaveCalled = false
    installHostBridge(async (method) => {
      if (method === 'selfCheck') return SELF_CHECK
      if (method === 'selector.get') return { selector: null }
      if (method === 'selector.save') { selectorSaveCalled = true; return {} }
      if (method === 'resolve') {
        const resolutions: Resolution[] = [
          { handle: { frameId: 0, fid: 0, epoch: 1 }, tier: 'proposed', value: 'Proposed answer', source: 'llm_key', key: 'salary', answerId: null, reason: 'llm' },
          { handle: { frameId: 0, fid: 1, epoch: 1 }, tier: 'needs_input', value: 'My drafted answer', source: null, key: null, answerId: null, reason: 'unknown' },
        ]
        return { epoch: 1, resolutions, llmError: null }
      }
      return {}
    })
    let calls = 0
    let releaseTab: (() => void) | null = null
    tabsGet().mockImplementation(async () => {
      calls++
      // Call 1 is the mount's auto-scan; call 2 is the pick's own getTab — park it.
      if (calls === 2) return await new Promise((r) => { releaseTab = () => r(GLOBEX) })
      return ACME
    })
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReplyFor(['Work model', 'Why us?'])
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_PICK') {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, pick: { selector: '#jd', text: 'Old page job description' } } }], failures: [] }
      }
      if (msg?.kind === 'toContent') return jobTextReply
      return { ok: true }
    })
    render(<App />)
    await waitFor(() => { expect(statusNow()).toBe('done') })
    fireEvent.click(screen.getByRole('button', { name: 'Pick job description' }))
    await waitFor(() => { expect(releaseTab).not.toBeNull() })
    await navigateBoundTab()
    releaseTab!()
    // The navigation's own replay scan settling is proof the pick's guarded write
    // (or non-write) has already run.
    await waitFor(() => { expect(statusNow()).toBe('done') })
    expect(selectorSaveCalled).toBe(false)
  })

  it('keeps a company the user typed across a navigation', async () => {
    // Harness adaptation (Task 14): the step-2 page is SAME-SITE (careers.acme.com
    // shares acme.com with jobs.acme.com) — a cross-site hop now PARKS the
    // session instead of re-scanning. Its TITLE still names a different employer,
    // so the assertion keeps its teeth: a fresh guess would overwrite 'Initech'.
    const STEP2 = { id: 7, url: 'https://careers.acme.com/apply/step2', title: 'Engineer at Globex' }
    let onNewPage = false
    tabsGet().mockImplementation(async () => (onNewPage ? STEP2 : ACME))
    installFullScan()
    render(<App />)
    await waitFor(() => { expect(companyInput().value).toBe('Acme') })
    fireEvent.change(companyInput(), { target: { value: 'Initech' } })
    onNewPage = true
    await navigateBoundTab(STEP2.url)
    await waitFor(() => { expect(statusNow()).toBe('done') })
    expect(companyInput().value).toBe('Initech')
  })

  it('never lets a dead scan company guess name the live page employer', async () => {
    // The guess is a post-await write like any other: `tab` is read before the
    // navigation and answers after it.
    let releaseTab: (() => void) | null = null
    let calls = 0
    tabsGet().mockImplementation(async () => {
      calls++
      if (calls === 1) return await new Promise((r) => { releaseTab = () => r(ACME) })
      return GLOBEX
    })
    installFullScan()
    render(<App />)
    await waitFor(() => { expect(releaseTab).not.toBeNull() })
    await navigateBoundTab()
    releaseTab!()
    // 'Acme' here would also SUPPRESS the live page's guess: the field is no longer empty.
    await waitFor(() => { expect(companyInput().value).toBe('Globex') })
  })
})

describe('App per-field fill failures', () => {
  const enumField = (fid: number, label: string) => ({
    frameId: -1, fid, epoch: 1, label, name: null, idAttr: null, kind: 'text',
    options: [], required: false, visible: true, currentValue: null, demographic: false,
  })
  const resolutions: Resolution[] = [
    { handle: { frameId: 0, fid: 0, epoch: 1 }, tier: 'proposed', value: 'Proposed answer', source: 'llm_key', key: 'salary', answerId: null, reason: 'llm' },
    { handle: { frameId: 0, fid: 1, epoch: 1 }, tier: 'needs_input', value: 'My drafted answer', source: null, key: null, answerId: null, reason: 'unknown' },
  ]

  /** The content script answers ok:true and reports the refusal PER FIELD — the
   *  envelope alone says nothing about whether the value reached the page. */
  const fillReply = {
    ok: true,
    replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [{ handle: { frameId: 0, fid: 0, epoch: 1 }, reason: 'no-matching-option' }] } } }],
    failures: [],
  }

  beforeEach(async () => {
    installHostBridge(async (method) => {
      if (method === 'selfCheck') return SELF_CHECK
      if (method === 'selector.get') return { selector: null }
      if (method === 'resolve') return { epoch: 1, resolutions, llmError: null }
      return {}
    })
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        return {
          ok: true,
          replies: [{ frameId: 0, url: 'https://jobs.acme.com/apply', payload: { ok: true, scan: { epoch: 1, fields: [enumField(0, 'Work model'), enumField(1, 'Why us?')], unreachableWidgets: 0, activeCaptcha: false } } }],
          failures: [],
        }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL') return fillReply
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      return { ok: true }
    })
  })

  const renderScanned = async (): Promise<void> => {
    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done')
    })
  }

  it('does not promote a proposed row whose fill the page refused', async () => {
    await renderScanned()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('action_failed')
    })
    // Still Proposed: promoting to Filled would tell the user a lie about the page.
    expect(document.querySelector('li[data-jff-tier="proposed"]')).not.toBeNull()
    expect(document.querySelector('li[data-jff-tier="auto"]')).toBeNull()
    expect(screen.getByText(/Accept failed: no-matching-option/)).toBeTruthy()
  })

  it('does not mark a needs-input row "on the page" when the page refused the value', async () => {
    await renderScanned()
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }))
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('action_failed')
    })
    expect(screen.queryByText('on the page')).toBeNull()
    expect(screen.getByText(/Fill failed: no-matching-option/)).toBeTruthy()
  })

  it('still confirms a fill the page accepted', async () => {
    // Mutation guard: the failure check must read `failed`, not reject every reply.
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    const base = send.getMockImplementation()!
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL') {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [{ handle: { frameId: 0, fid: 1, epoch: 1 }, committed: null }], failed: [] } } }], failures: [] }
      }
      return base(msg)
    })
    await renderScanned()
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }))
    expect(await screen.findByText('on the page')).toBeTruthy()
  })

  it('retires the action_failed line once the retried fill succeeds', async () => {
    // The red line is about ONE attempt. Left on screen after the user fixed the
    // value and the retry went through, it reads as a still-broken page.
    let pageAccepts = false
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    const base = send.getMockImplementation()!
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL' && pageAccepts) {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [{ handle: { frameId: 0, fid: 1, epoch: 1 }, committed: null }], failed: [] } } }], failures: [] }
      }
      return base(msg)
    })
    await renderScanned()
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }))
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('action_failed')
    })
    pageAccepts = true
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }))
    // Back to what the SCAN said, not stuck on the failed attempt.
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done')
    })
    expect(screen.queryByText(/Fill failed/)).toBeNull()
  })

  it('locks every row while one row is acting', async () => {
    let release: (() => void) | null = null
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    const base = send.getMockImplementation()!
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL') {
        return await new Promise((r) => { release = () => r(fillReply) })
      }
      return base(msg)
    })
    await renderScanned()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    // The OTHER row's buttons: serialization is global, so the lockout must be too.
    const fill = await screen.findByRole('button', { name: 'Fill' }) as HTMLButtonElement
    expect(fill.disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Generate with AI' }) as HTMLButtonElement).disabled).toBe(true)
    release!()
    await waitFor(() => expect((screen.getByRole('button', { name: 'Fill' }) as HTMLButtonElement).disabled).toBe(false))
  })
})

describe('App generate request', () => {
  it('sends the field description along with the Generate request', async () => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        return {
          ok: true,
          replies: [{
            frameId: 0, url: 'https://jobs.acme.com/apply',
            payload: { ok: true, scan: { epoch: 1, fields: [{
              frameId: -1, fid: 0, epoch: 1, label: 'Authorized to work?', name: null, idAttr: null, kind: 'text',
              options: [], required: false, visible: true, currentValue: null, demographic: false,
              description: 'Answer for your current country.',
            }], unreachableWidgets: 0, activeCaptcha: false } },
          }],
          failures: [],
        }
      }
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      return { ok: true }
    })

    const generateCalls: unknown[] = []
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        return { requestId, ok: true, result: { epoch: 1, resolutions: [
          { handle: { frameId: 0, fid: 0, epoch: 1 }, tier: 'needs_input', value: null, source: null, key: null, answerId: null, reason: 'custom' },
        ], llmError: null } }
      }
      if (method === 'generate') { generateCalls.push(params); return { requestId, ok: true, result: { draft: 'A draft' } } }
      return { requestId, ok: true, result: {} }
    }

    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate with AI' }))

    await waitFor(() => expect(generateCalls).toHaveLength(1))
    expect(generateCalls[0]).toMatchObject({
      questionRaw: 'Authorized to work?',
      description: 'Answer for your current country.',
    })
  })

  it('sends stored CV text with the Generate request', async () => {
    await saveResume(new File(['%PDF-1.4'], 'cv.pdf', { type: 'application/pdf' }), async () => 'MY CV TEXT')
    try {
      const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
      send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
        if (msg?.kind === 'inject') return { ok: true, frames: [0] }
        if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
          return {
            ok: true,
            replies: [{ frameId: 0, url: 'https://jobs.acme.com/apply', payload: { ok: true, scan: { epoch: 1, fields: [{
              frameId: -1, fid: 0, epoch: 1, label: 'Why us?', name: null, idAttr: null, kind: 'textarea',
              options: [], required: false, visible: true, currentValue: null, demographic: false,
            }], unreachableWidgets: 0, activeCaptcha: false } } }],
            failures: [],
          }
        }
        if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        return { ok: true }
      })
      const generateCalls: unknown[] = []
      window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
        if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
        if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
        if (method === 'resolve') {
          return { requestId, ok: true, result: { epoch: 1, resolutions: [
            { handle: { frameId: 0, fid: 0, epoch: 1 }, tier: 'needs_input', value: null, source: null, key: null, answerId: null, reason: 'custom' },
          ], llmError: null } }
        }
        if (method === 'generate') { generateCalls.push(params); return { requestId, ok: true, result: { draft: 'A draft' } } }
        return { requestId, ok: true, result: {} }
      }
      render(<App />)
      await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
      fireEvent.click(screen.getByRole('button', { name: 'Generate with AI' }))
      await waitFor(() => expect(generateCalls).toHaveLength(1))
      expect(generateCalls[0]).toMatchObject({ cvText: 'MY CV TEXT' })
    } finally {
      await clearResume()
    }
  })
})

describe('App — election rendering (A7/A9)', () => {
  const twoFrameScanReply = {
    ok: true,
    replies: [
      { frameId: 0, url: 'https://careers.acme.com/', payload: { ok: true, scan: { epoch: 1, fields: [
        { frameId: -1, fid: 0, epoch: 1, label: 'Newsletter email', name: 'email', idAttr: null, kind: 'text', options: [], required: false, visible: true, currentValue: null, demographic: false },
      ], unreachableWidgets: 0, activeCaptcha: false } } },
      { frameId: 1, url: 'https://ats.acme.com/embed', payload: { ok: true, scan: { epoch: 1, fields: [
        { frameId: -1, fid: 0, epoch: 1, label: 'First name', name: 'first', idAttr: null, kind: 'text', options: [], required: true, visible: true, currentValue: null, demographic: false },
        { frameId: -1, fid: 1, epoch: 1, label: 'Why us?', name: 'why', idAttr: null, kind: 'textarea', options: [], required: false, visible: true, currentValue: null, demographic: false },
      ], unreachableWidgets: 0, activeCaptcha: false } } },
    ],
    failures: [],
  }

  function installTwoFrameScan(): void {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0, 1] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return twoFrameScanReply
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 1, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [] } } }], failures: [] }
      return { ok: true }
    })
    // Resolutions come back for the ELECTED frame's fields only, like the real host.
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        const p = params as { fields: { frameId: number; fid: number }[] }
        return { requestId, ok: true, result: { epoch: 1, resolutions: p.fields.map((f) => ({
          handle: { frameId: f.frameId, fid: f.fid, epoch: 1 }, tier: 'needs_input' as const,
          value: null, source: null, key: null, answerId: null, reason: 'custom',
        })), llmError: null } }
      }
      return { requestId, ok: true, result: {} }
    }
  }

  it('renders elected rows in document order and demotes the newsletter field', async () => {
    installTwoFrameScan()
    render(<App />)
    await waitFor(() => expect(document.querySelectorAll('[data-jff-rows] li')).toHaveLength(2))
    const labels = Array.from(document.querySelectorAll('[data-jff-rows] li label.font-semibold')).map((n) => n.textContent)
    expect(labels).toEqual(['First name', 'Why us?'])
    const foreignEl = document.querySelector('[data-jff-foreign]')!
    expect(foreignEl.textContent).toContain('Other page fields (1)')
    expect(foreignEl.textContent).toContain('ats.acme.com') // the ELECTED frame is named
    expect(foreignEl.textContent).toContain('Newsletter email')
  })

  it('offers no Generate on a foreign row but keeps manual Fill', async () => {
    installTwoFrameScan()
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-foreign]')).not.toBeNull())
    const rowEl = document.querySelector('[data-jff-foreign] li')!
    const names = Array.from(rowEl.querySelectorAll('button')).map((b) => b.textContent ?? '')
    expect(names.some((n) => n.includes('Generate'))).toBe(false)
    expect(names.some((n) => n.includes('Fill'))).toBe(true)
  })
})

describe('App — resume row wiring (A8/A9)', () => {
  it('puts the stored resume on the page from the winning file row, targeting its own fid', async () => {
    const { saveResume } = await import('./resume')
    await saveResume(new File([new Uint8Array([1, 2, 3])], 'cv.pdf', { type: 'application/pdf' }), async () => null)
    const sentMessages: { type?: string; handle?: { fid: number } }[] = []
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string; handle?: { fid: number } } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message !== undefined) sentMessages.push(msg.message)
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        return { ok: true, replies: [{ frameId: 0, url: 'https://ats.example/', payload: { ok: true, scan: { epoch: 1, fields: [
          { frameId: -1, fid: 0, epoch: 1, label: null, name: null, idAttr: null, kind: 'file', options: [], required: false, visible: true, currentValue: null, demographic: false },
          { frameId: -1, fid: 1, epoch: 1, label: 'Resume', name: 'resume', idAttr: null, kind: 'file', options: [], required: true, visible: true, currentValue: null, demographic: false, accept: '.pdf' },
        ], unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true } }], failures: [] }
      return { ok: true }
    })
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        const p = params as { fields: { frameId: number; fid: number }[] }
        return { requestId, ok: true, result: { epoch: 1, resolutions: p.fields.map((f) => ({
          handle: { frameId: f.frameId, fid: f.fid, epoch: 1 }, tier: 'needs_input' as const,
          value: null, source: null, key: null, answerId: null, reason: 'custom',
        })), llmError: null } }
      }
      return { requestId, ok: true, result: {} }
    }
    render(<App />)
    const putButton = await screen.findByRole('button', { name: 'Put on page' })
    // The scan already uploaded once (auto path); the ROW re-upload is the user's.
    fireEvent.click(putButton)
    await waitFor(() => {
      const uploads = sentMessages.filter((m) => m.type === 'JFF_FILL_RESUME')
      expect(uploads.length).toBeGreaterThanOrEqual(1)
      // every upload targeted the WINNING fid, never the fid-0 autofill pane
      expect(uploads.every((u) => u.handle!.fid === 1)).toBe(true)
    })
  })
})

describe('App — B3 page-accepted fills and failure surfacing', () => {
  function installScanWithFillReport(): void {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    const fields = [
      { frameId: -1, fid: 0, epoch: 1, label: 'First name', name: 'first', idAttr: null, kind: 'text', options: [], required: true, visible: true, currentValue: null, demographic: false },
      { frameId: -1, fid: 1, epoch: 1, label: 'Authorized to work?', name: 'auth', idAttr: null, kind: 'choice', options: ['Yes', 'No'], required: true, visible: false, currentValue: null, demographic: false },
    ]
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string; fills?: { handle: { frameId: number; fid: number; epoch: number } }[] } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        return { ok: true, replies: [{ frameId: 0, url: 'https://ats.example/', payload: { ok: true, scan: { epoch: 1, fields, unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL') {
        const fills = msg.message.fills!
        // The page accepted the text fill and REFUSED the choice fill.
        return {
          ok: true,
          replies: [{ frameId: 0, payload: { ok: true, fill: {
            epoch: 1,
            filled: fills.filter((f) => f.handle.fid === 0).map((f) => ({ handle: f.handle, committed: null })),
            failed: fills.filter((f) => f.handle.fid === 1).map((f) => ({ handle: f.handle, reason: 'choice-needs-user-click' })),
          } } }],
          failures: [],
        }
      }
      if (msg?.kind === 'toContent') return { ok: true, replies: [{ frameId: 0, payload: { ok: true } }], failures: [] }
      return { ok: true }
    })
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        const p = params as { fields: { frameId: number; fid: number; kind: string }[] }
        return { requestId, ok: true, result: { epoch: 1, resolutions: p.fields.map((f) => ({
          handle: { frameId: f.frameId, fid: f.fid, epoch: 1 }, tier: 'auto' as const,
          value: f.kind === 'choice' ? 'Yes' : 'Kevin', source: 'profile' as const,
          key: null, answerId: null, reason: 'test',
        })), llmError: null } }
      }
      if (method === 'selector.get') return { requestId, ok: true, result: { selector: null } }
      return { requestId, ok: true, result: {} }
    }
  }

  it('counts only page-accepted fills and demotes the failed row with its reason and hint', async () => {
    installScanWithFillReport()
    render(<App />)
    // 1 page-accepted (text) — NOT 2, even though both resolutions are tier auto.
    await screen.findByText('✓ 1 filled, 0 already on page, 0 proposed, 1 need input')
    // The failed choice row dropped to needs-input styling with the refusal hint.
    const demoted = Array.from(document.querySelectorAll('li[data-jff-tier="needs_input"]'))
      .find((li) => li.textContent?.includes('Authorized to work?'))
    expect(demoted).toBeDefined()
    expect(demoted!.textContent).toContain('Select this answer on the page yourself.')
    // The accepted row keeps its auto tier.
    const kept = Array.from(document.querySelectorAll('li[data-jff-tier="auto"]'))
      .find((li) => li.textContent?.includes('First name'))
    expect(kept).toBeDefined()
  })
})

describe('App — committed canonical text (B1c)', () => {
  function installComboScan(committed: string | null, tier: 'needs_input' | 'auto'): void {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') {
        return {
          ok: true,
          replies: [{ frameId: 0, url: 'https://jobs.acme.com/apply', payload: { ok: true, scan: { epoch: 1, fields: [
            { frameId: -1, fid: 0, epoch: 1, label: 'Country', name: null, idAttr: null, kind: 'combobox', options: [], required: false, visible: true, currentValue: null, demographic: false },
          ], unreachableWidgets: 0, activeCaptcha: false } } }],
          failures: [],
        }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL') {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [{ handle: { frameId: 0, fid: 0, epoch: 1 }, committed }], failed: [] } } }], failures: [] }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      }
      if (msg?.kind === 'toContent') return { ok: true, replies: [], failures: [] }
      return { ok: true }
    })
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        return { requestId, ok: true, result: { epoch: 1, resolutions: [{
          handle: { frameId: 0, fid: 0, epoch: 1 }, tier,
          value: tier === 'auto' ? 'bra' : null,
          source: tier === 'auto' ? 'profile' : null,
          key: null, answerId: null, reason: tier === 'auto' ? 'test' : 'custom',
        }], llmError: null } }
      }
      return { requestId, ok: true, result: {} }
    }
  }

  it('a single-row Fill adopts the page-accepted canonical text into the row value', async () => {
    installComboScan('Brazil', 'needs_input')
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'bra' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }))
    await screen.findByText('on the page')
    expect((screen.getByLabelText('Country') as HTMLInputElement).value).toBe('Brazil')
  })

  it('a batched scan fill seeds the row value with the committed text', async () => {
    installComboScan('Brazil', 'auto')
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    expect((screen.getByLabelText('Country') as HTMLInputElement).value).toBe('Brazil')
  })

  it('never confirms a fill the report does not mention (fill unreported)', async () => {
    installComboScan(null, 'needs_input')
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    const base = send.getMockImplementation()!
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_FILL') {
        // Schema-valid, but the fill appears in NEITHER list.
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [] } } }], failures: [] }
      }
      return base(msg)
    })
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'bra' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }))
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('action_failed'))
    expect(screen.getAllByText(/fill unreported/).length).toBeGreaterThan(0)
    expect(screen.queryByText('on the page')).toBeNull()
  })
})

describe('App — per-field generating state (B3)', () => {
  const twoFieldScan = {
    ok: true,
    replies: [{
      frameId: 0, url: 'https://jobs.acme.com/apply',
      payload: { ok: true, scan: { epoch: 1, fields: [
        { frameId: -1, fid: 0, epoch: 1, label: 'Why us?', name: null, idAttr: null, kind: 'textarea', options: [], required: false, visible: true, currentValue: null, demographic: false },
        { frameId: -1, fid: 1, epoch: 1, label: 'Biggest achievement?', name: null, idAttr: null, kind: 'textarea', options: [], required: false, visible: true, currentValue: null, demographic: false },
      ], unreachableWidgets: 0, activeCaptcha: false } },
    }],
    failures: [],
  }

  function installNeedsInputScan(
    onGen: (params: { handle: { fid: number } }, requestId: string) => HostResponse | Promise<HostResponse>,
  ): void {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return twoFieldScan
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_JOBTEXT') {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      }
      if (msg?.kind === 'toContent') return { ok: true, replies: [], failures: [] }
      return { ok: true }
    })
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        return { requestId, ok: true, result: { epoch: 1, resolutions: [0, 1].map((fid) => ({
          handle: { frameId: 0, fid, epoch: 1 }, tier: 'needs_input' as const, value: null, source: null, key: null, answerId: null, reason: 'custom',
        })), llmError: null } }
      }
      if (method === 'generate') return await onGen(params as { handle: { fid: number } }, requestId)
      return { requestId, ok: true, result: {} }
    }
  }

  it("keeps each row's spinner independent under concurrent generates", async () => {
    const pending: Record<number, (draft: string) => void> = {}
    installNeedsInputScan((params, requestId) => new Promise((resolve) => {
      pending[params.handle.fid] = (draft) => resolve({ requestId, ok: true, result: { draft } })
    }))
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    const buttons = screen.getAllByRole('button', { name: 'Generate with AI' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    fireEvent.click(buttons[1]!)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Drafting…' })).toHaveLength(2))
    await act(async () => { pending[1]!('Second draft') })
    // Completing ONE request must not steal the other's spinner (the old
    // single-generatingRef bug: the first completion nulled the second's).
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Drafting…' })).toHaveLength(1)
      expect(screen.getByDisplayValue('Second draft')).toBeTruthy()
    })
    await act(async () => { pending[0]!('First draft') })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Drafting…' })).toBeNull()
      expect(screen.getByDisplayValue('First draft')).toBeTruthy()
    })
  })

  it('drops a draft that resolves after a tab-scope reset (gen-epoch guard)', async () => {
    let finish: (() => void) | null = null
    installNeedsInputScan((params, requestId) => new Promise((resolve) => {
      finish = () => resolve({ requestId, ok: true, result: { draft: 'Dead-page draft' } })
    }))
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate with AI' })[0]!)
    await waitFor(() => expect(finish).not.toBeNull())
    // The bound tab navigates SAME-SITE: webNavigation commits the wizard step.
    await commit(7, 'https://jobs.acme.com/apply/step2')
    // The reset triggers a re-scan; let it settle, THEN let the dead generate answer.
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    await act(async () => { finish!() })
    expect(screen.queryByDisplayValue('Dead-page draft')).toBeNull()
  })

  it('generates all remaining sequentially with a progress label', async () => {
    const calls: number[] = []
    const pending: ((draft: string) => void)[] = []
    installNeedsInputScan((params, requestId) => new Promise((resolve) => {
      calls.push(params.handle.fid)
      pending.push((draft) => resolve({ requestId, ok: true, result: { draft } }))
    }))
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.click(screen.getByRole('button', { name: 'Generate all remaining (2)' }))
    // Sequential: exactly ONE request in flight, with row-by-row progress.
    await screen.findByRole('button', { name: 'Generating 1/2…' })
    expect(calls).toEqual([0])
    await act(async () => { pending[0]!('Draft zero') })
    await screen.findByRole('button', { name: 'Generating 2/2…' })
    expect(calls).toEqual([0, 1])
    await act(async () => { pending[1]!('Draft one') })
    await waitFor(() => {
      expect(screen.getByDisplayValue('Draft zero')).toBeTruthy()
      expect(screen.getByDisplayValue('Draft one')).toBeTruthy()
    })
    // Everything drafted: nothing left to batch-generate.
    expect(screen.queryByRole('button', { name: /Generate all remaining/ })).toBeNull()
  })

  it('skips a transiently-failing row and continues the batch', async () => {
    const calls: number[] = []
    installNeedsInputScan((params, requestId) => {
      calls.push(params.handle.fid)
      return params.handle.fid === 0
        ? { requestId, ok: false, error: { kind: 'timeout', message: 'slow' } }
        : { requestId, ok: true, result: { draft: 'Draft one' } }
    })
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.click(screen.getByRole('button', { name: 'Generate all remaining (2)' }))
    await waitFor(() => expect(screen.getByDisplayValue('Draft one')).toBeTruthy())
    expect(calls).toEqual([0, 1])
    // The skipped row is still eligible afterwards.
    expect(screen.getByRole('button', { name: 'Generate all remaining (1)' })).toBeTruthy()
  })

  it('stops the batch on a terminal host error kind', async () => {
    const calls: number[] = []
    installNeedsInputScan((params, requestId) => {
      calls.push(params.handle.fid)
      return { requestId, ok: false, error: { kind: 'rate_limit', message: 'limit' } }
    })
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.click(screen.getByRole('button', { name: 'Generate all remaining (2)' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate all remaining (2)' })).toBeTruthy())
    expect(calls).toEqual([0]) // row 1 was never attempted
  })
})

describe('App — onboarding gate (O1/O3)', () => {
  const scanCount = (): number => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    return send.mock.calls.filter((c) => (c[0] as { message?: { type?: string } })?.message?.type === 'JFF_SCAN').length
  }
  const emptyProfileBridge = (): void => {
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      return { requestId, ok: true, result: {} }
    }
  }

  it('a fresh install renders OnboardingView and fires NO scan', async () => {
    await clearResume()
    emptyProfileBridge()
    render(<App />)
    await screen.findByText('Welcome — set up your profile')
    expect(document.querySelector('[data-jff-onboarding]')).not.toBeNull()
    expect(document.querySelector('[data-jff-rows]')).toBeNull()
    expect(scanCount()).toBe(0)
  })

  it('a dead host is unknown: normal panel + banner, never the onboarding wall', async () => {
    await clearResume()
    window.__jffHostBridge = async ({ requestId }): Promise<HostResponse> =>
      ({ requestId, ok: false, error: { kind: 'unreachable', message: 'down' } })
    render(<App />)
    await waitFor(() => expect(scanCount()).toBeGreaterThan(0), { timeout: 5000 })
    expect(document.querySelector('[data-jff-onboarding]')).toBeNull()
  })

  it('an onboarded profile never sees the gate', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    expect(document.querySelector('[data-jff-onboarding]')).toBeNull()
  })

  it('an open host gate cannot race a scan past an unsettled completeness decision', async () => {
    // profile.get never resolves: the decision stays pending, and no scan may
    // fire even though selfCheck answered (gateOpen latched true).
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'profile.get' || method === 'answerBank.get') return new Promise<HostResponse>(() => {})
      return { requestId, ok: true, result: {} }
    }
    // hostWaitMs pinned past the test budget ON PURPOSE: this test's premise is a
    // decision that stays pending forever, which is exactly the state the O3
    // anti-brick latch exists to break — at the default 10s it fires, scans, and
    // fails this negative assertion on any machine slow enough to still be here.
    // The latch is correct product behavior ('a never-settling facts load times
    // out to unknown and scans anyway' below pins it); this test is about the
    // window BEFORE it, so move it out of reach rather than race it.
    render(<App hostWaitMs={60_000} />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('connecting'))
    await new Promise((r) => setTimeout(r, 150))
    expect(scanCount()).toBe(0)
  })

  it('a never-settling facts load times out to unknown and scans anyway', async () => {
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'profile.get' || method === 'answerBank.get') return new Promise<HostResponse>(() => {})
      return { requestId, ok: true, result: {} }
    }
    render(<App hostWaitMs={60} />)
    await waitFor(() => expect(scanCount()).toBeGreaterThan(0), { timeout: 5000 })
    expect(document.querySelector('[data-jff-onboarding]')).toBeNull()
  })

  it('Finish persists the facts and unlocks exactly one scan', async () => {
    await clearResume()
    const calls: string[] = []
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      calls.push(method)
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      return { requestId, ok: true, result: {} }
    }
    render(<App />)
    await screen.findByText('Welcome — set up your profile')
    fireEvent.change(document.querySelector('[data-jff-ob-resume] input[type="file"]')!,
      { target: { files: [new File(['cv'], 'cv.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText(/cv\.txt/)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'k@x.dev' } })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Kevin B' } })
    const finish = screen.getByRole('button', { name: 'Finish setup' })
    await waitFor(() => expect((finish as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(finish)
    await waitFor(() => expect(calls).toContain('profile.set'))
    await waitFor(() => expect(document.querySelector('[data-jff-onboarding]')).toBeNull())
    await waitFor(() => expect(scanCount()).toBe(1))
  })

  it('a failed profile.set keeps the gate closed — nothing unlocks on a lie', async () => {
    await clearResume()
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'profile.set') return { requestId, ok: false, error: { kind: 'db', message: 'disk full' } }
      return { requestId, ok: true, result: {} }
    }
    render(<App />)
    await screen.findByText('Welcome — set up your profile')
    fireEvent.change(document.querySelector('[data-jff-ob-resume] input[type="file"]')!,
      { target: { files: [new File(['cv'], 'cv.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText(/cv\.txt/)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'k@x.dev' } })
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/^Full name/), { target: { value: 'Kevin B' } })
    const finish = screen.getByRole('button', { name: 'Finish setup' })
    await waitFor(() => expect((finish as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(finish)
    // The failure surfaced; the gate stays; no scan ever fires.
    await new Promise((r) => setTimeout(r, 100))
    expect(document.querySelector('[data-jff-onboarding]')).not.toBeNull()
    expect(scanCount()).toBe(0)
  })
})

describe('App — mark applied (A2)', () => {
  function markingBridge(behind: { params: unknown[] }, fail = false): void {
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'applied.mark') {
        behind.params.push(params)
        if (fail) return { requestId, ok: false, error: { kind: 'db', message: 'nope' } }
        return { requestId, ok: true, result: { id: 1, url: (params as { url: string }).url, canonicalUrl: 'c', company: null, jobTitle: null, markedAt: '2026-07-29T00:00:00.000Z' } }
      }
      if (method === 'resolve') {
        return { requestId, ok: true, result: { epoch: 1, resolutions: [], llmError: null } }
      }
      return { requestId, ok: true, result: {} }
    }
  }

  it('records the START url, tab title and company, then ends the session', async () => {
    const seen = { params: [] as unknown[] }
    markingBridge(seen)
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.change(document.querySelector('[data-jff-company] input')!, { target: { value: 'Acme' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark applied' }))
    await waitFor(() => expect(seen.params.length).toBe(1))
    expect(seen.params[0]).toEqual({ url: 'https://jobs.acme.com/apply', company: 'Acme', jobTitle: 'Engineer at Acme' })
    // Session ended: rows gone, badge line up.
    await waitFor(() => expect(document.querySelector('[data-jff-rows]')).toBeNull())
    expect(document.querySelector('[data-jff-applied]')).not.toBeNull()
  })

  it('a failed mark keeps the session (retryable) and surfaces the host banner', async () => {
    const seen = { params: [] as unknown[] }
    markingBridge(seen, true)
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.click(screen.getByRole('button', { name: 'Mark applied' }))
    await waitFor(() => expect(seen.params.length).toBe(1))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Mark applied' }) as HTMLButtonElement).disabled).toBe(false))
    expect(document.querySelector('[data-jff-applied]')).toBeNull()
  })

  it('the button is disabled before any scan captured a start url', async () => {
    markingBridge({ params: [] })
    render(<App />)
    // Before the auto-scan settles the button must not be actionable.
    expect((screen.getByRole('button', { name: 'Mark applied' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('App — submission detection prompt (A3)', () => {
  /** Scan 1: one field. After the simulated navigation, scan 2: zero fields and
   *  a confirmation body. The harness flips on a mutable switch. */
  function installWizardEnd(state: { done: boolean }): void {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    const base = send.getMockImplementation()!
    send.mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN' && state.done) {
        return {
          ok: true,
          replies: [{ frameId: 0, url: 'https://jobs.acme.com/apply/done', payload: { ok: true, scan: { epoch: 2, fields: [], unreachableWidgets: 0, activeCaptcha: false } } }],
          failures: [],
        }
      }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_PAGETEXT') {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, pageText: state.done ? 'Thank you for applying to Acme' : 'form page' } }], failures: [] }
      }
      return base(msg)
    })
  }
  /** Harness adaptation (Task 14): the wizard's confirmation step is a SAME-SITE
   *  webNavigation commit — that is what keeps the session and re-scans. */
  const navigate = async (): Promise<void> => { await commit(7, 'https://jobs.acme.com/apply/done') }

  it('a same-site navigation re-scan to zero fields prompts — and never writes on its own', async () => {
    const state = { done: false }
    installWizardEnd(state)
    const marks: unknown[] = []
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') return { requestId, ok: true, result: { epoch: 1, resolutions: [], llmError: null } }
      if (method === 'applied.mark') { marks.push(params); return { requestId, ok: true, result: { markedAt: '2026-07-29T00:00:00.000Z' } } }
      return { requestId, ok: true, result: {} }
    }
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    state.done = true
    // The wizard advanced: the TAB now sits on the confirmation url, so the
    // start-vs-current assertion below is distinguishable, not vacuous.
    const tabs = (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } }).chrome.tabs
    tabs.get.mockResolvedValue({ id: 7, url: 'https://jobs.acme.com/apply/done', title: 'Engineer at Acme' })
    await navigate()
    await waitFor(() => expect(document.querySelector('[data-jff-submit-prompt]')).not.toBeNull(), { timeout: 3000 })
    expect(screen.getByText(/Mark as applied\?/)).toBeTruthy()
    expect(marks.length).toBe(0) // never a silent write
    // data hook, not getByRole: the actions row has its own 'Mark applied'
    // button (Task 5), and two buttons sharing the accessible name would make
    // getByRole throw "Found multiple elements".
    fireEvent.click(document.querySelector('[data-jff-prompt-mark]')!)
    await waitFor(() => expect(marks.length).toBe(1))
    // Wizard flow: the RECORDED url is the START page, not the confirmation step.
    expect(marks[0]).toMatchObject({ url: 'https://jobs.acme.com/apply' })
  })

  it('dismissing never re-prompts for the same page load', async () => {
    const state = { done: false }
    installWizardEnd(state)
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    state.done = true
    await navigate()
    await waitFor(() => expect(document.querySelector('[data-jff-submit-prompt]')).not.toBeNull(), { timeout: 3000 })
    fireEvent.click(document.querySelector('[data-jff-prompt-dismiss]')!)
    expect(document.querySelector('[data-jff-submit-prompt]')).toBeNull()
    // A manual re-scan of the SAME page load must not resurrect the prompt.
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('empty'))
    expect(document.querySelector('[data-jff-submit-prompt]')).toBeNull()
  })
})

describe('App — revisit badge (A4)', () => {
  const HIT = { id: 1, url: 'https://jobs.acme.com/apply', canonicalUrl: 'c', company: 'Acme', jobTitle: 'Eng', markedAt: '2026-07-01T00:00:00.000Z' }
  const scanCount = (): number => {
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.runtime.sendMessage
    return send.mock.calls.filter((c) => (c[0] as { message?: { type?: string } })?.message?.type === 'JFF_SCAN').length
  }
  function checkBridge(applied: unknown, checkFails = false): void {
    window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'applied.check') {
        if (checkFails) return { requestId, ok: false, error: { kind: 'db', message: 'nope' } }
        return { requestId, ok: true, result: { applied } }
      }
      return { requestId, ok: true, result: {} }
    }
  }

  it('a previously applied page renders the badge INSTEAD of scanning', async () => {
    checkBridge(HIT)
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-applied]')).not.toBeNull())
    expect(screen.getByText(/Already applied on/)).toBeTruthy()
    expect(scanCount()).toBe(0)
  })

  it('Scan anyway overrides the badge and scans exactly once', async () => {
    checkBridge(HIT)
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-applied]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Scan anyway' }))
    await waitFor(() => expect(scanCount()).toBe(1))
    expect(document.querySelector('[data-jff-applied]')).toBeNull()
  })

  it('a failed applied.check proceeds as not-applied', async () => {
    checkBridge(null, true)
    render(<App />)
    await waitFor(() => expect(scanCount()).toBe(1))
    expect(document.querySelector('[data-jff-applied]')).toBeNull()
  })
})

describe('App — three-view navigation (A5)', () => {
  it('session, facts editor and applications are mutually exclusive', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    fireEvent.click(screen.getByRole('button', { name: 'Applications' }))
    await waitFor(() => expect(document.querySelector('[data-jff-apps]')).not.toBeNull())
    expect(document.querySelector('[data-jff-rows]')).toBeNull()
    expect(document.querySelector('[data-jff-editor]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit your facts' }))
    await waitFor(() => expect(document.querySelector('[data-jff-editor]')).not.toBeNull())
    expect(document.querySelector('[data-jff-apps]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to fields' }))
    await waitFor(() => expect(document.querySelector('main')?.getAttribute('data-jff-view')).toBe('session'))
    expect(document.querySelector('[data-jff-editor]')).toBeNull()
    expect(document.querySelector('[data-jff-apps]')).toBeNull()
  })
})

describe('App — per-tab sessions (S2/S5/S6)', () => {
  const APPLY_A = 'https://jobs.acme.com/apply'
  const STEP_2 = 'https://careers.acme.com/apply/step2'
  const SSO = 'https://okta-sso.com/login'
  const JOB_B = 'https://jobs.globex.com/apply'
  const MARKED_AT = '2026-07-29T00:00:00.000Z'
  const MARKED_ON = new Date(MARKED_AT).toLocaleDateString()
  const EMPTY_COPY = 'No application session on this tab yet. Click Scan to start.'

  const sendMock = () => chromeFake().runtime.sendMessage
  const tabsGet = () => chromeFake().tabs.get
  const status = (): string | null | undefined =>
    document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')
  const sessionAttr = (): string | null | undefined =>
    document.querySelector('main')?.getAttribute('data-jff-session')
  const scanCount = (): number =>
    sendMock().mock.calls.filter((c) => (c[0] as { message?: { type?: string } })?.message?.type === 'JFF_SCAN').length
  const row = (tabId: number): Session | undefined => storageRows()[`jff:session:${tabId}`] as Session | undefined
  const appliedNodes = (): number => document.querySelectorAll('[data-jff-applied]').length
  /** Park the store's read of ONE session row until the returned `release` is
   *  called. The store serializes every operation on a single FIFO lock, so this
   *  is what lets a test observe a tab swap while it is still in flight — and it
   *  proves the ordering too: the parked read can only have been issued after
   *  every operation enqueued ahead of it finished. */
  const parkSessionLoad = (tabId: number): { release: () => void; issued: () => boolean } => {
    const area = (globalThis as unknown as {
      chrome: { storage: { session: { get: ReturnType<typeof vi.fn> } } }
    }).chrome.storage.session
    const realGet = area.get.getMockImplementation() as (k: string | string[] | null) => Promise<Record<string, unknown>>
    let release = (): void => {}
    const parked = new Promise<void>((r) => { release = r })
    let issued = false
    area.get.mockImplementation(async (keys: string | string[] | null) => {
      // One-shot: restore the real get so nothing behind this parks too.
      if (keys === `jff:session:${tabId}`) { issued = true; area.get.mockImplementation(realGet); await parked }
      return await realGet(keys)
    })
    return { release: () => { release() }, issued: () => issued }
  }

  /** Every tab the panel asked the background to relay TO, in order — narrowed to
   *  one content-message type when given. */
  const relayTargets = (type?: string): (number | undefined)[] =>
    sendMock().mock.calls
      .map((c) => c[0] as { kind?: string; tabId?: number; message?: { type?: string } })
      .filter((m) => m?.kind === 'toContent' && (type === undefined || m.message?.type === type))
      .map((m) => m.tabId)

  const field = (fid: number, label: string): EnumField => ({
    frameId: 0, fid, epoch: 1, label, name: null, idAttr: null, kind: 'text',
    options: [], required: false, visible: true, currentValue: null, demographic: false,
  })
  const resolutionFor = (fid: number): Resolution => ({
    handle: { frameId: 0, fid, epoch: 1 }, tier: 'needs_input',
    value: null, source: null, key: null, answerId: null, reason: 'custom',
  })

  const scanReply = (url: string, label: string) => ({
    ok: true,
    replies: [{
      frameId: 0, url,
      payload: { ok: true, scan: { epoch: 1, fields: [{ ...field(0, label), frameId: -1 }], unreachableWidgets: 0, activeCaptcha: false } },
    }],
    failures: [],
  })

  interface HostState { marks: { url: string }[]; applied: Set<string> }
  const newHostState = (): HostState => ({ marks: [], applied: new Set<string>() })

  const installBridge = (state: HostState): void => {
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        const p = params as { fields: { frameId: number; fid: number }[] }
        return { requestId, ok: true, result: { epoch: 1, resolutions: p.fields.map((f) => resolutionFor(f.fid)), llmError: null } }
      }
      if (method === 'applied.check') {
        const url = (params as { url: string }).url
        return { requestId, ok: true, result: { applied: state.applied.has(url) ? { markedAt: MARKED_AT } : null } }
      }
      if (method === 'applied.mark') {
        const p = params as { url: string }
        state.marks.push(p)
        state.applied.add(p.url)
        return { requestId, ok: true, result: { markedAt: MARKED_AT } }
      }
      return { requestId, ok: true, result: {} }
    }
  }

  /** inject + one enumerated field + no job text: a scan that settles `done`. */
  const installScan = (urlOf: () => string = () => APPLY_A, labelOf: () => string = () => 'Email'): void => {
    sendMock().mockImplementation(async (msg: { kind?: string; message?: { type?: string } }) => {
      if (msg?.kind === 'inject') return { ok: true, frames: [0] }
      if (msg?.kind === 'toContent' && msg.message?.type === 'JFF_SCAN') return scanReply(urlOf(), labelOf())
      if (msg?.kind === 'toContent') {
        return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      }
      return { ok: true }
    })
  }

  const mountScanned = async (): Promise<void> => {
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
  }

  beforeEach(() => { installBridge(newHostState()) })

  it('a tab switch saves the session and displays the activated tab: empty state, NO scan', async () => {
    installScan()
    await mountScanned()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'kevin@example.com' } })
    const scansBefore = scanCount()

    await activate(8)

    await waitFor(() => { expect(sessionAttr()).toBe('none') })
    expect(screen.getByText(EMPTY_COPY)).toBeTruthy()
    expect(document.querySelector('[data-jff-rows]')).toBeNull()
    // Tab 8 has no session: nothing to re-scan, and a scan per tab switch would
    // spend one batched `claude -p` resolve every time.
    expect(scanCount()).toBe(scansBefore)
    await waitFor(() => { expect(row(7)?.edits['0:0']).toBe('kevin@example.com') })
    expect(row(8)).toBeUndefined()
  })

  it('switching back restores the first session with its work intact', async () => {
    installScan()
    await mountScanned()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'kevin@example.com' } })
    await activate(8)
    await waitFor(() => { expect(sessionAttr()).toBe('none') })
    const scansBefore = scanCount()

    await activate(7)

    await waitFor(() => { expect(sessionAttr()).toBe('7') })
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('kevin@example.com')
    // Restoring is not re-scanning.
    expect(scanCount()).toBe(scansBefore)
  })

  it('an activation from another window is ignored', async () => {
    installScan()
    await mountScanned()

    await activate(8, 2)

    expect(sessionAttr()).toBe('7')
    expect(screen.getByLabelText('Email')).toBeTruthy()
  })

  it('cross-site navigation PARKS; returning to the domain restores', async () => {
    installScan()
    await mountScanned()
    const scansBefore = scanCount()

    await commit(7, SSO)

    await waitFor(() => { expect(document.querySelector('[data-jff-parked]')).not.toBeNull() })
    expect(screen.getByText('Session parked — return to acme.com to continue. Scanning is paused on this page.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Scan' }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('[data-jff-rows]')).toBeNull()
    await waitFor(() => { expect(row(7)?.parked).toBe(true) })
    expect(scanCount()).toBe(scansBefore)

    await commit(7, STEP_2)

    await waitFor(() => { expect(scanCount()).toBe(scansBefore + 1) })
    await waitFor(() => { expect(document.querySelector('[data-jff-parked]')).toBeNull() })
    await waitFor(() => { expect(row(7)?.parked).toBe(false) })
    expect(await screen.findByLabelText('Email')).toBeTruthy()
  })

  it('panel reopen rehydrates from storage and prunes dead tabs', async () => {
    // The scan parks on inject, so what renders can only be the REHYDRATED row.
    sendMock().mockImplementation(async (msg: { kind?: string }) => {
      if (msg?.kind === 'inject') return await new Promise(() => undefined)
      return { ok: true, replies: [], failures: [] }
    })
    const seeded: Session = {
      ...newSession(7, APPLY_A),
      fields: [field(0, 'Email')],
      resolutions: [resolutionFor(0)],
      edits: { '0:0': 'seeded@example.com' },
    }
    storageRows()['jff:session:7'] = capForStorage(seeded)
    storageRows()['jff:session:99'] = capForStorage(newSession(99, 'https://jobs.initech.com/apply'))
    // chrome.tabs.query({}) answers only tab 7: tab 99 is dead.

    render(<App />)

    await waitFor(() => { expect(sessionAttr()).toBe('7') })
    expect(((await screen.findByLabelText('Email')) as HTMLInputElement).value).toBe('seeded@example.com')
    await waitFor(() => { expect(storageRows()['jff:session:99']).toBeUndefined() })
  })

  it('tab close deletes the session', async () => {
    installScan()
    await mountScanned()
    await waitFor(() => { expect(row(7)).toBeDefined() })

    await closeTab(7)

    await waitFor(() => { expect(row(7)).toBeUndefined() })
    await waitFor(() => { expect(sessionAttr()).toBe('none') })
    expect(screen.getByText(EMPTY_COPY)).toBeTruthy()
  })

  it('Mark applied deletes the session instead of hand-clearing state', async () => {
    const state = newHostState()
    installBridge(state)
    installScan()
    await mountScanned()
    await waitFor(() => { expect(row(7)).toBeDefined() })

    fireEvent.click(screen.getByRole('button', { name: 'Mark applied' }))

    await waitFor(() => { expect(state.marks).toHaveLength(1) })
    await waitFor(() => { expect(row(7)).toBeUndefined() })
    await waitFor(() => { expect(sessionAttr()).toBe('none') })
    expect(screen.getByText(EMPTY_COPY)).toBeTruthy()
    // B8: the session it would have ridden on no longer exists, so the
    // confirmation is the panel-global one — and it is the ONLY applied node.
    expect(screen.getByText(`Marked as applied on ${MARKED_ON}.`)).toBeTruthy()
    expect(appliedNodes()).toBe(1)

    // Transient: cleared on a tab switch.
    await activate(8)
    await waitFor(() => { expect(appliedNodes()).toBe(0) })
    await activate(7)
    await waitFor(() => { expect(sessionAttr()).toBe('none') })
    expect(appliedNodes()).toBe(0)

    // S5 overlap guard: the check now HITS the just-marked url. markedMsg wins
    // while set and onScan clears it on entry, so exactly one badge exists at
    // every observable point.
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    expect(appliedNodes()).toBeLessThanOrEqual(1)
    await waitFor(() => { expect(screen.getByText(/Already applied on/)).toBeTruthy() })
    expect(appliedNodes()).toBe(1)
  })

  it('Discard deletes the session', async () => {
    const state = newHostState()
    installBridge(state)
    installScan()
    await mountScanned()
    await waitFor(() => { expect(row(7)).toBeDefined() })

    fireEvent.click(screen.getByRole('button', { name: 'Discard session' }))

    await waitFor(() => { expect(row(7)).toBeUndefined() })
    await waitFor(() => { expect(sessionAttr()).toBe('none') })
    expect(screen.getByText(EMPTY_COPY)).toBeTruthy()
    expect(state.marks).toHaveLength(0)
  })

  it('never marks job A once the same tab moved on to job B (Task 5 boundary defect)', async () => {
    // The pre-session panel PRESERVED startUrl across every `navigated` reset and
    // capture was first-wins, so job B's scan could not replace job A's url:
    // Mark applied recorded job A while job B was on screen. The S5 classifier
    // plus the hardened disabled predicate are what close it.
    const state = newHostState()
    installBridge(state)
    let tab = { id: 7, url: APPLY_A, title: 'Engineer at Acme' }
    tabsGet().mockImplementation(async () => tab)
    installScan(() => tab.url)
    await mountScanned()
    await waitFor(() => { expect(row(7)?.startUrl).toBe(APPLY_A) })

    // The user opens a DIFFERENT job in the same tab.
    tab = { id: 7, url: JOB_B, title: 'Engineer at Globex' }
    await commit(7, JOB_B)
    await waitFor(() => { expect(document.querySelector('[data-jff-parked]')).not.toBeNull() })

    // Job A's session is parked, so nothing on this screen may be marked as it.
    const markBtn = screen.getByRole('button', { name: 'Mark applied' }) as HTMLButtonElement
    expect(markBtn.disabled).toBe(true)
    fireEvent.click(markBtn)
    await new Promise((r) => setTimeout(r, 20))
    expect(state.marks).toHaveLength(0)

    // Job B gets its own session, and its own start url.
    fireEvent.click(screen.getByRole('button', { name: 'Discard session' }))
    await waitFor(() => { expect(sessionAttr()).toBe('none') })
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    await waitFor(() => { expect(status()).toBe('done') })
    await waitFor(() => { expect((screen.getByRole('button', { name: 'Mark applied' }) as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'Mark applied' }))

    await waitFor(() => { expect(state.marks).toHaveLength(1) })
    expect(state.marks[0]!.url).toBe(JOB_B)
    expect(state.marks.some((m) => m.url === APPLY_A)).toBe(false)
  })

  it('a full storage area warns in its OWN banner, never through the host banner', async () => {
    // S6: `hostError` feeds SelfCheckBanner AND the hostAnswered→gateOpen latch;
    // a storage warning is not a host answer, and routing it there would be a
    // category error with a scan-gate side effect.
    installScan()
    const area = statefulSessionArea(storageRows())
    area.set.mockImplementation(async () => { throw new Error('QUOTA_BYTES quota exceeded') })
    ;(globalThis as unknown as { chrome: { storage: { session: unknown } } }).chrome.storage.session = area

    await mountScanned()

    await waitFor(() => { expect(document.querySelector('[data-jff-storage-warn]')).not.toBeNull() })
    expect(screen.getByText('Session storage is full — recent changes may not survive closing the panel.')).toBeTruthy()
    // The host is still reported as healthy: the warning did not ride hostError.
    expect(screen.getByText(/Host ready/)).toBeTruthy()
  })

  it('an in-flight scan keeps relaying to the tab it was DISPATCHED for, never the one on screen', async () => {
    // The relay target is resolved at CALL time. Before the per-tab era the panel
    // was bound to ONE tab for its lifetime, so an in-flight scan's closure pinned
    // every message to the tab the scan started on; a mutable binding retargets the
    // rest of that scan to whatever is displayed when the await resolves. JFF_FILL
    // WRITES to the page — the later inScope check drops the RESULT, but the
    // message has already been delivered to the wrong tab.
    let releaseResolve = (): void => {}
    const resolving = new Promise<void>((r) => { releaseResolve = r })
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'resolve') {
        await resolving
        const p = params as { fields: { fid: number }[] }
        // tier 'auto' with a value is what makes runScan batch a JFF_FILL.
        const resolutions: Resolution[] = p.fields.map((f) => ({
          handle: { frameId: 0, fid: f.fid, epoch: 1 }, tier: 'auto',
          value: 'kevin@example.com', source: 'profile', key: null, answerId: null, reason: 'recognizer:email',
        }))
        return { requestId, ok: true, result: { epoch: 1, resolutions, llmError: null } }
      }
      return { requestId, ok: true, result: {} }
    }
    installScan()
    render(<App />)
    // The scan is parked inside `resolve`, dispatched for tab 7.
    await waitFor(() => { expect(status()).toBe('resolving') })

    await activate(8)
    await waitFor(() => { expect(sessionAttr()).toBe('none') })

    await act(async () => { releaseResolve() })

    await waitFor(() => { expect(relayTargets('JFF_FILL').length).toBeGreaterThan(0) })
    expect(relayTargets('JFF_FILL')).toEqual([7])
    // Nothing this scan sends may reach tab 8 — not the fill, not the enumeration.
    expect(relayTargets()).not.toContain(8)
  })

  it('a tab closing while a swap to another LIVE tab is in flight lands on that tab, not the dead one', async () => {
    // Chrome activates the successor BEFORE it emits `removed`, so the swap toward
    // the live tab is routinely already in flight when the close arrives. A removal
    // that invalidates ALL swap work strands the panel on the dead tab — and since
    // the successor is already active, no further `activated` is coming to repair it.
    installScan()
    await mountScanned()
    await waitFor(() => { expect(row(7)).toBeDefined() })
    storageRows()['jff:session:8'] = capForStorage(newSession(8, JOB_B))

    // Park the swap on its INCOMING load, so the removal's own tail runs while
    // that swap is still in flight — the window a blanket display(null) blanks.
    const incoming = parkSessionLoad(8)

    const onActivated = await firstListener<(i: { tabId: number; windowId: number }) => void>(
      chromeFake().tabs.onActivated)
    const onRemoved = await firstListener<(id: number) => void>(chromeFake().tabs.onRemoved)
    // Both events inside one turn: the swap suspends on its outgoing flush before
    // `removed` runs, which is exactly the real ordering.
    await act(async () => { onActivated({ tabId: 8, windowId: 1 }); onRemoved(7) })

    // The store lock serializes flush → remove → load, so the incoming load being
    // issued proves the removal already finished: its row is gone and its tail ran.
    await waitFor(() => { expect(incoming.issued()).toBe(true) })
    expect(row(7)).toBeUndefined()
    // …and it did NOT clobber the swap: no flash of the empty state on the way.
    expect(sessionAttr()).toBe('7')

    await act(async () => { incoming.release() })

    await waitFor(() => { expect(sessionAttr()).toBe('8') })
    expect(document.querySelector('[data-jff-tab]')?.getAttribute('data-jff-tab')).toBe('8')
  })

  it('a swap toward a tab that CLOSES mid-swap is abandoned — the dead tab never reaches the display', async () => {
    // The other half of the same rule: a removal invalidates exactly the work
    // that would put the REMOVED tab on screen. Here that IS the in-flight swap.
    installScan()
    await mountScanned()
    storageRows()['jff:session:8'] = capForStorage(newSession(8, JOB_B))
    const incoming = parkSessionLoad(8)

    const onActivated = await firstListener<(i: { tabId: number; windowId: number }) => void>(
      chromeFake().tabs.onActivated)
    const onRemoved = await firstListener<(id: number) => void>(chromeFake().tabs.onRemoved)
    await act(async () => { onActivated({ tabId: 8, windowId: 1 }) })
    await waitFor(() => { expect(incoming.issued()).toBe(true) })

    // Tab 8 closes while the panel is still loading its session. `remove` queues
    // BEHIND the parked read on the store lock, so release it to let both finish.
    await act(async () => { onRemoved(8) })
    await act(async () => { incoming.release() })

    await waitFor(() => { expect(row(8)).toBeUndefined() })
    expect(sessionAttr()).toBe('7')
    expect(screen.getByLabelText('Email')).toBeTruthy()
  })

  it('a repeated navigated event for the same url is idempotent', async () => {
    // navSignals' fallback dedupe is one-directional: Chrome can emit a combined
    // tabs.onUpdated {status:'loading', url} AHEAD of onCommitted, i.e. TWO
    // identical `navigated` events for one navigation.
    installScan()
    await mountScanned()
    const afterMount = scanCount()

    await commit(7, STEP_2)
    await commit(7, STEP_2)
    await waitFor(() => { expect(status()).toBe('done') })
    // Exactly ONE re-scan, and one nonce spent on it.
    expect(scanCount()).toBe(afterMount + 1)
    expect(document.querySelector('main')?.getAttribute('data-jff-scans')).toBe('1')

    await commit(7, SSO)
    await commit(7, SSO)
    await waitFor(() => { expect(document.querySelector('[data-jff-parked]')).not.toBeNull() })
    await waitFor(() => { expect(row(7)?.parked).toBe(true) })
    // No double-park: the session's own work is untouched and no scan ran.
    expect(row(7)?.startUrl).toBe(APPLY_A)
    expect(scanCount()).toBe(afterMount + 1)

    await commit(7, STEP_2)
    await commit(7, STEP_2)
    await waitFor(() => { expect(document.querySelector('[data-jff-parked]')).toBeNull() })
    await waitFor(() => { expect(status()).toBe('done') })
    // No double-unpark: exactly one further scan.
    expect(scanCount()).toBe(afterMount + 2)
  })
})
