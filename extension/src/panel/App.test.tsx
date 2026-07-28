import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App, hostnameOf } from './App'

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
    expect(screen.getByText('✓ 0 filled, 0 proposed, 0 need input')).toBeTruthy()
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
