import { afterEach, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { act } from '@testing-library/react'
import type { EnumField, FieldHandle, HostResponse, Resolution } from '@jff/shared'
import { clearResume, saveResume } from '../resume'

/**
 * Test-only. The panel seam for Resolution in two steps: a fake Native host
 * whose `resolve.mapping` reply each test holds back and releases, over fake
 * browser APIs whose page takes every value it is sent. What a test asserts is
 * what the page and the user see.
 *
 * `installHeldMappingHost()` registers its own beforeEach and afterEach, so a
 * test file calls it once at the top level and reads the returned state.
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

export const field = (fid: number, label: string, patch: Partial<EnumField> = {}): EnumField => ({
  frameId: -1, fid, epoch: 1, label, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

export const resolution = (h: FieldHandle, patch: Partial<Resolution>): Resolution => ({
  handle: { frameId: h.frameId, fid: h.fid, epoch: h.epoch },
  tier: 'needs_input', value: null, source: null, key: null, answerId: null, reason: 'custom', ...patch,
})

export interface Held { fields: EnumField[]; reply: (r: HostResponse) => void; requestId: string }

export interface HeldMappingHost {
  /** The Fields every Scan enumerates. Set before render. */
  fields: EnumField[]
  /** fid → the value the first step fills. Every other Field is left pending,
   *  unless `firstNeedsInput` decides it. */
  firstValues: Record<number, string>
  /** fids the first step decides as Needs input (a recognizer with no stored Value). */
  firstNeedsInput: number[]
  /** When true the first step decides every Field and nothing is pending. */
  nothingPending: boolean
  /** When true `resolve.first` never answers, so a Scan stays on its first step. */
  holdFirst: boolean
  /** What Mapping decides, per pending Field. */
  mappingFor: (fields: EnumField[]) => Resolution[]
  held: Held[]
  firstRequests: EnumField[][]
  mappingCount: number
  /** fid → what the page holds. */
  page: Record<number, string>
  fills: { epoch: number; fids: number[] }[]
  scans: number
  /** chrome.storage.session, as the fake holds it. */
  storage: Record<string, unknown>
}

export function installHeldMappingHost(): HeldMappingHost {
  const host = {} as HeldMappingHost

  beforeEach(async () => {
    window.history.replaceState(null, '', '/?jffFakeHost=1')
    Object.assign(host, {
      fields: [], firstValues: {}, firstNeedsInput: [], nothingPending: false, holdFirst: false,
      mappingFor: (fs: EnumField[]) => fs.map((f) => resolution(f, {})),
      held: [], firstRequests: [], mappingCount: 0, page: {}, fills: [], scans: 0, storage: {},
    } satisfies HeldMappingHost)
    ;(globalThis as unknown as { chrome: unknown }).chrome = fakeChrome(host)
    await saveResume(new File(['stub resume'], 'cv.txt', { type: 'text/plain' }))
    window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
      const p = params as { epoch: number; fields: EnumField[] }
      if (method === 'profile.get') return { requestId, ok: true, result: ONBOARDED }
      if (method === 'selfCheck') return { requestId, ok: true, result: SELF_CHECK }
      if (method === 'selector.get') return { requestId, ok: true, result: { selector: null } }
      if (method === 'resolve.first') {
        host.firstRequests.push(p.fields)
        if (host.holdFirst) return await new Promise<HostResponse>(() => {})
        const decided = p.fields.filter((f) =>
          host.nothingPending || f.fid in host.firstValues || host.firstNeedsInput.includes(f.fid))
        return { requestId, ok: true, result: {
          epoch: p.epoch,
          resolutions: decided.map((f) => host.firstValues[f.fid] !== undefined
            ? resolution(f, { tier: 'auto', value: host.firstValues[f.fid]!, source: 'profile', reason: 'recognizer' })
            : resolution(f, { tier: 'needs_input', reason: 'recognizer:no-stored-value' })),
          pending: p.fields.filter((f) => !decided.includes(f)).map((f) => ({ frameId: f.frameId, fid: f.fid, epoch: f.epoch })),
        } }
      }
      if (method === 'resolve.mapping') {
        host.mappingCount++
        return await new Promise<HostResponse>((reply) => { host.held.push({ fields: p.fields, reply, requestId }) })
      }
      return { requestId, ok: true, result: {} }
    }
  })

  afterEach(async () => {
    // Nothing may stay parked into the next test.
    for (const h of host.held) h.reply(mapped(host, h))
    delete window.__jffHostBridge
    await clearResume()
  })

  return host
}

/** A Mapping reply to a held request: Mapping's decisions, or a model error. */
export const mapped = (
  host: HeldMappingHost, h: Held, llmError: { kind: 'rate_limit'; message: string } | null = null,
): HostResponse => ({
  requestId: h.requestId, ok: true,
  result: {
    epoch: 0, llmError,
    resolutions: llmError === null ? host.mappingFor(h.fields) : h.fields.map((f) => resolution(f, { reason: `llm-error:${llmError.kind}` })),
  },
})

/** Release the oldest held Mapping request with this answer. */
export async function release(host: HeldMappingHost, answer: (h: Held) => HostResponse): Promise<void> {
  const h = host.held.shift()!
  await act(async () => { h.reply(answer(h)) })
}

export const status = (): string | null | undefined =>
  document.querySelector('[data-jff-status]')?.getAttribute('data-jff-status')
export const statusText = (): string => document.querySelector('[data-jff-status]')?.textContent ?? ''

const labelOf = (li: Element): string => li.querySelector(':scope > div .font-semibold')?.textContent ?? '?'
/** Labels of the rows that carry a Resolution, in order. */
export const rowLabels = (): string[] =>
  [...document.querySelectorAll('[data-jff-rows] li[data-jff-tier]')].map(labelOf)
/** Labels of the rows still being matched, in order. */
export const waitingLabels = (): string[] =>
  [...document.querySelectorAll('[data-jff-rows] li[data-jff-waiting]')].map(labelOf)
export const rowOf = (label: string): Element | undefined =>
  [...document.querySelectorAll('[data-jff-rows] li')].find((li) => labelOf(li) === label)
export const tierOf = (label: string): string | null | undefined => rowOf(label)?.getAttribute('data-jff-tier')

function fakeChrome(host: HeldMappingHost): unknown {
  const rows = host.storage
  return {
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
          host.scans++
          return { ok: true, replies: [{ frameId: 0, url: 'https://jobs.example.com/apply', payload: { ok: true, scan: { epoch: m.epoch, fields: host.fields, unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        }
        if (msg?.kind === 'toContent' && m?.type === 'JFF_FILL') {
          // The page takes every value it is sent, and reports it filled.
          for (const f of m.fills ?? []) host.page[f.handle.fid] = f.value
          host.fills.push({ epoch: m.epoch ?? -1, fids: (m.fills ?? []).map((f) => f.handle.fid) })
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
}
