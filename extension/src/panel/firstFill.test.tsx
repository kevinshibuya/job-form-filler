import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { EnumField, FieldHandle, HostResponse, Resolution } from '@jff/shared'
import { App } from './App'
import { clearResume, saveResume } from './resume'

/**
 * Resolution in two steps, at the panel seam: the App renders against a fake
 * Native host whose `resolve.mapping` reply each test holds back and releases.
 * What is asserted is what the page and the user see: which values the page
 * holds, which rows show, and what the status line says.
 */

// jsdom's Blob has no `arrayBuffer()`, which `saveResume` needs (same shim as
// App.test.tsx; inert in a real browser).
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

const SELF_CHECK = {
  node: { ok: true, version: 'v20.0.0' },
  claude: { ok: true, path: '(fake)', detail: 'found' },
  auth: { ok: true, detail: 'logged in' },
  codex: { ok: true, path: '(fake)', detail: 'found' },
  codexAuth: { ok: true, detail: 'logged in' },
  db: { ok: true, path: '(fake)' },
}
const ONBOARDED = { email: 'ada@example.com', phone: '+1 555 0100', fullName: 'Ada Lovelace' }

const field = (fid: number, label: string): EnumField => ({
  frameId: -1, fid, epoch: 1, label, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false,
})

/** fid 0 and 1 need no model; 2 and 3 wait on Mapping. */
const PAGE = [field(0, 'First name'), field(1, 'Email'), field(2, 'Why us?'), field(3, 'Salary expectation')]
const FIRST_VALUES: Record<number, string> = { 0: 'Ada', 1: 'ada@example.com' }

const resolution = (h: FieldHandle, patch: Partial<Resolution>): Resolution => ({
  handle: { frameId: h.frameId, fid: h.fid, epoch: h.epoch },
  tier: 'needs_input', value: null, source: null, key: null, answerId: null, reason: 'custom', ...patch,
})

/** What Mapping decides for the two pending Fields. */
const mappingFor = (fields: EnumField[]): Resolution[] => fields.map((f) => f.fid === 3
  ? resolution(f, { tier: 'proposed', value: '120000', source: 'llm_key', key: 'salary', reason: 'llm-key:salary' })
  : resolution(f, {}))

interface Held { fields: EnumField[]; reply: (r: HostResponse) => void; requestId: string }

let held: Held[] = []
let firstRequests: EnumField[][] = []
let page: Record<number, string> = {}
let fills: { epoch: number; fids: number[] }[] = []
let scans = 0
let nothingPending = false
let mappingCount = 0

function installHost(): void {
  window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
    const p = params as { epoch: number; fields: EnumField[] }
    if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
    if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
    if (method === 'selector.get') return { requestId, ok: true, result: { selector: null } }
    if (method === 'resolve.first') {
      firstRequests.push(p.fields)
      const decided = p.fields.filter((f) => nothingPending || f.fid in FIRST_VALUES)
      return { requestId, ok: true, result: {
        epoch: p.epoch,
        resolutions: decided.map((f) => FIRST_VALUES[f.fid] !== undefined
          ? resolution(f, { tier: 'auto', value: FIRST_VALUES[f.fid]!, source: 'profile', reason: 'recognizer' })
          : resolution(f, { tier: 'needs_input', reason: 'recognizer:no-stored-value' })),
        pending: p.fields.filter((f) => !decided.includes(f)).map((f) => ({ frameId: f.frameId, fid: f.fid, epoch: f.epoch })),
      } }
    }
    if (method === 'resolve.mapping') {
      mappingCount++
      return await new Promise<HostResponse>((reply) => { held.push({ fields: p.fields, reply, requestId }) })
    }
    return { requestId, ok: true, result: {} }
  }
}

/** Release the oldest held Mapping request with this answer. */
async function release(answer: (h: Held) => HostResponse): Promise<void> {
  const h = held.shift()!
  await act(async () => { h.reply(answer(h)) })
}
const mapped = (h: Held, llmError: { kind: 'rate_limit'; message: string } | null = null): HostResponse =>
  ({ requestId: h.requestId, ok: true, result: { epoch: 0, resolutions: llmError === null ? mappingFor(h.fields) : h.fields.map((f) => resolution(f, { reason: `llm-error:${llmError.kind}` })), llmError } })

const status = (): string | null | undefined => document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')
const rowLabels = (): string[] =>
  [...document.querySelectorAll('[data-jff-rows] li')].map((li) => PAGE.find((f) => li.textContent?.includes(f.label!))?.label ?? '?')
const tierOf = (label: string): string | null | undefined =>
  [...document.querySelectorAll('[data-jff-rows] li')].find((li) => li.textContent?.includes(label))?.getAttribute('data-jff-tier')

beforeEach(async () => {
  window.history.replaceState(null, '', '/?jffFakeHost=1')
  held = []
  firstRequests = []
  page = {}
  fills = []
  scans = 0
  nothingPending = false
  mappingCount = 0
  const rows: Record<string, unknown> = {}
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: 'https://jobs.example.com/apply', title: 'Engineer at Example' }]),
      get: vi.fn(async () => ({ id: 7, url: 'https://jobs.example.com/apply', title: 'Engineer at Example' })),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn(async (msg: { kind?: string; message?: { type?: string; epoch?: number; fills?: { handle: FieldHandle; value: string }[] } }) => {
        if (msg?.kind === 'inject') return { ok: true, frames: [0] }
        const m = msg?.message
        if (msg?.kind === 'toContent' && m?.type === 'JFF_SCAN') {
          scans++
          return { ok: true, replies: [{ frameId: 0, url: 'https://jobs.example.com/apply', payload: { ok: true, scan: { epoch: m.epoch, fields: PAGE, unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        }
        if (msg?.kind === 'toContent' && m?.type === 'JFF_FILL') {
          // The page takes every value it is sent, and reports it filled.
          for (const f of m.fills ?? []) page[f.handle.fid] = f.value
          fills.push({ epoch: m.epoch ?? -1, fids: (m.fills ?? []).map((f) => f.handle.fid) })
          return { ok: true, replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: m.epoch, filled: (m.fills ?? []).map((f) => ({ handle: f.handle, committed: null })), failed: [] } } }], failures: [] }
        }
        if (msg?.kind === 'toContent') {
          return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        }
        return { ok: true }
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: {
      session: {
        get: vi.fn(async (keys: string | string[] | null) => {
          if (keys === null || keys === undefined) return { ...rows }
          const out: Record<string, unknown> = {}
          for (const k of typeof keys === 'string' ? [keys] : keys) if (k in rows) out[k] = rows[k]
          return out
        }),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(rows, items) }),
        remove: vi.fn(async (keys: string | string[]) => { for (const k of typeof keys === 'string' ? [keys] : keys) delete rows[k] }),
      },
    },
  }
  await saveResume(new File(['stub resume'], 'cv.txt', { type: 'text/plain' }))
  installHost()
})

afterEach(async () => {
  // Nothing may stay parked into the next test.
  for (const h of held) h.reply(mapped(h))
  delete window.__jffHostBridge
  await clearResume()
})

/** Mount and wait until the first step has settled with Mapping held. */
async function mountHeld(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(held).toHaveLength(1) })
  await waitFor(() => { expect(rowLabels()).toEqual(['First name', 'Email']) })
}

describe('First Fill lands before Mapping answers', () => {
  it('fills the identity Fields and shows their rows while the Mapping reply is held', async () => {
    await mountHeld()
    // On the page, not just in the panel.
    expect(page).toEqual({ 0: 'Ada', 1: 'ada@example.com' })
    expect(tierOf('First name')).toBe('auto')
    expect(tierOf('Email')).toBe('auto')
    // The pending Fields have no row yet, and the status line says matching.
    expect(rowLabels()).not.toContain('Why us?')
    expect(status()).toBe('resolving')
    // The second request carries the pending Fields only.
    expect(held[0]!.fields.map((f) => f.fid)).toEqual([2, 3])
  })

  it('adds a row per pending Field when the reply lands, and fills nothing again', async () => {
    await mountHeld()
    const fillsBefore = fills.length
    await release((h) => mapped(h))
    await waitFor(() => { expect(rowLabels()).toEqual(['First name', 'Email', 'Why us?', 'Salary expectation']) })
    expect(tierOf('Why us?')).toBe('needs_input')
    expect(tierOf('Salary expectation')).toBe('proposed')
    expect(fills).toHaveLength(fillsBefore)
    expect(fills.flatMap((f) => f.fids)).toEqual([0, 1])
    await waitFor(() => { expect(status()).toBe('done') })
    expect(screen.getByText('✓ 2 filled, 0 already on page, 1 proposed, 1 need input')).toBeTruthy()
  })

  it('makes every pending Field Needs input with the error when the request fails outright', async () => {
    await mountHeld()
    await release((h) => ({ requestId: h.requestId, ok: false, error: { kind: 'rate_limit', message: 'limit' } }))
    await waitFor(() => { expect(rowLabels()).toHaveLength(4) })
    expect(tierOf('Why us?')).toBe('needs_input')
    expect(tierOf('Salary expectation')).toBe('needs_input')
    expect(status()).toBe('failed')
    expect(document.querySelector('[data-jff-banner="error"]')?.textContent).toMatch(/rate limit/i)
    // What the first step filled stays filled.
    expect(page).toEqual({ 0: 'Ada', 1: 'ada@example.com' })
    expect(tierOf('First name')).toBe('auto')
  })

  it('does the same for a reply that carries a model error', async () => {
    await mountHeld()
    await release((h) => mapped(h, { kind: 'rate_limit', message: 'limit' }))
    await waitFor(() => { expect(rowLabels()).toHaveLength(4) })
    expect(tierOf('Why us?')).toBe('needs_input')
    expect(tierOf('Salary expectation')).toBe('needs_input')
    expect(status()).toBe('failed')
    expect(document.querySelector('[data-jff-banner="error"]')?.textContent).toMatch(/rate limit/i)
    expect(tierOf('First name')).toBe('auto')
  })

  it('starts a newer Scan without waiting, and drops the older reply when it lands', async () => {
    await mountHeld()
    const scanButton = await screen.findByRole('button', { name: 'Scan' })
    await waitFor(() => { expect((scanButton as HTMLButtonElement).disabled).toBe(false) })
    const scansBefore = scans
    fireEvent.click(scanButton)
    // The newer Scan ran its whole first step with the old reply still held.
    await waitFor(() => { expect(held).toHaveLength(2) })
    expect(scans).toBeGreaterThan(scansBefore)
    await waitFor(() => { expect(status()).toBe('resolving') })
    const fillsBefore = fills.length

    // The OLD reply now lands, with an auto answer it would fill if it counted.
    await release((h) => ({ requestId: h.requestId, ok: true, result: { epoch: 0, llmError: null, resolutions: h.fields.map((f) =>
      resolution(f, { tier: 'auto', value: 'STALE', source: 'answer_bank', reason: 'stale' })) } }))
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(rowLabels()).toEqual(['First name', 'Email'])
    expect(fills).toHaveLength(fillsBefore)
    expect(Object.values(page)).not.toContain('STALE')
    expect(status()).toBe('resolving')

    // The newer Scan's own reply still lands.
    await release((h) => mapped(h))
    await waitFor(() => { expect(rowLabels()).toHaveLength(4) })
  })

  it('sends no second request when nothing is pending', async () => {
    nothingPending = true
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    expect(firstRequests).toHaveLength(1)
    expect(held).toHaveLength(0)
    expect(mappingCount).toBe(0)
    expect(rowLabels()).toHaveLength(4)
  })

  it('keeps an edit typed into a first-step row while the reply is held', async () => {
    await mountHeld()
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Augusta' } })
    await release((h) => mapped(h))
    await waitFor(() => { expect(rowLabels()).toHaveLength(4) })
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Augusta')
  })
})
