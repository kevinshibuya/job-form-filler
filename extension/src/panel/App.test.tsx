import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { HostResponse, Resolution } from '@jff/shared'
import { App, hostnameOf } from './App'
import { clearResume, saveResume } from './resume'

/** The fake port forwards to `window.__jffHostBridge` when one is installed, so
 *  this is how a test gives the panel real resolutions (the canned fake answers
 *  every resolve with zero) or a host that never answers at all. */
function installHostBridge(answer: (method: string) => Promise<unknown>): void {
  window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> =>
    ({ requestId, ok: true, result: await answer(method) })
}

const SELF_CHECK = {
  node: { ok: true, version: 'v20.0.0' },
  claude: { ok: true, path: '(fake)', detail: 'found' },
  auth: { ok: true, detail: 'logged in' },
  db: { ok: true, path: '(fake)' },
}

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

afterEach(() => { delete window.__jffHostBridge })

beforeEach(() => {
  // The compile-time seam is on in tests (vitest define), so the fake host answers.
  window.history.replaceState(null, '', '/?jffFakeHost=1')
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
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
    // `remove` is required: onScan clears this tab's stale snapshot keys first.
    storage: { session: { get: vi.fn(async () => ({})), remove: vi.fn(async () => undefined) } },
  }
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

  /** Fire the tab-scope listener the panel registered, exactly as Chrome would
   *  when the bound tab starts loading a new document. */
  const navigateBoundTab = async (): Promise<void> => {
    const onUpdated = (globalThis as unknown as { chrome: { tabs: { onUpdated: { addListener: ReturnType<typeof vi.fn> } } } })
      .chrome.tabs.onUpdated.addListener.mock.calls[0]![0] as (id: number, change: { status: string }) => void
    await act(async () => { onUpdated(7, { status: 'loading' }) })
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

  const navigateBoundTab = async (): Promise<void> => {
    const onUpdated = (globalThis as unknown as { chrome: { tabs: { onUpdated: { addListener: ReturnType<typeof vi.fn> } } } })
      .chrome.tabs.onUpdated.addListener.mock.calls[0]![0] as (id: number, change: { status: string }) => void
    await act(async () => { onUpdated(7, { status: 'loading' }) })
  }

  /** Fires the tab-scope listener as Chrome would when a DIFFERENT tab becomes
   *  active — the bound tab itself neither navigates nor closes. */
  const activateOtherTab = async (): Promise<void> => {
    const onActivated = (globalThis as unknown as { chrome: { tabs: { onActivated: { addListener: ReturnType<typeof vi.fn> } } } })
      .chrome.tabs.onActivated.addListener.mock.calls[0]![0] as (info: { tabId: number }) => void
    await act(async () => { onActivated({ tabId: 99 }) })
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

  it('leaves the status line blank after a tab switch mid-scan, never superseded', async () => {
    // 'activated' never replays a scan (the tab that scanned is not the one that
    // just became active) — 'superseded' promises a rescan an activation reset
    // will not deliver, so the dead scan's own drain must leave the line blank.
    let releaseScan: (() => void) | null = null
    let resolveCalled = false
    installHostBridge(async (method) => {
      if (method === 'selfCheck') return SELF_CHECK
      if (method === 'selector.get') return { selector: null }
      if (method === 'resolve') {
        resolveCalled = true
        const resolutions: Resolution[] = [
          { handle: { frameId: 0, fid: 0, epoch: 1 }, tier: 'proposed', value: 'Proposed answer', source: 'llm_key', key: 'salary', answerId: null, reason: 'llm' },
          { handle: { frameId: 0, fid: 1, epoch: 1 }, tier: 'needs_input', value: 'My drafted answer', source: null, key: null, answerId: null, reason: 'unknown' },
        ]
        return { epoch: 1, resolutions, llmError: null }
      }
      return {}
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
    await activateOtherTab()
    expect(statusNow()).toBeUndefined()
    releaseScan!()
    // Let the dead scan run all the way through (its writes are dropped, not just
    // its status write) before asserting the line stayed blank.
    await waitFor(() => { expect(resolveCalled).toBe(true) })
    expect(statusNow()).toBeUndefined()
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

  it('clears a GUESSED company on navigation so the next employer is guessed fresh', async () => {
    // Otherwise employer B's saved answers are filed under employer A's name.
    let onNewPage = false
    tabsGet().mockImplementation(async () => (onNewPage ? GLOBEX : ACME))
    installFullScan()
    render(<App />)
    await waitFor(() => { expect(companyInput().value).toBe('Acme') })
    onNewPage = true
    await navigateBoundTab()
    await waitFor(() => { expect(companyInput().value).toBe('Globex') })
  })

  it('keeps a company the user typed across a navigation', async () => {
    let onNewPage = false
    tabsGet().mockImplementation(async () => (onNewPage ? GLOBEX : ACME))
    installFullScan()
    render(<App />)
    await waitFor(() => { expect(companyInput().value).toBe('Acme') })
    fireEvent.change(companyInput(), { target: { value: 'Initech' } })
    onNewPage = true
    await navigateBoundTab()
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
    // The bound tab navigates: tabScope fires 'navigated' on status:'loading'.
    const chromeMock = (globalThis as unknown as { chrome: { tabs: { onUpdated: { addListener: ReturnType<typeof vi.fn> } } } }).chrome
    const onUpdated = chromeMock.tabs.onUpdated.addListener.mock.calls[0]![0] as (id: number, change: { status?: string }) => void
    act(() => { onUpdated(7, { status: 'loading' }) })
    // The reset triggers a re-scan; let it settle, THEN let the dead generate answer.
    await waitFor(() => expect(document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')).toBe('done'))
    await act(async () => { finish!() })
    expect(screen.queryByDisplayValue('Dead-page draft')).toBeNull()
  })
})
