import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HostResponse } from '@jff/shared'
import { App } from './App'
import { field, installHeldMappingHost, status } from './testing/heldMapping'

/**
 * "Save a capture" (spec #41, ticket #47), the Side panel rendered with a fake
 * Native host. After any Scan the button asks the elected frame for its
 * cleaned page and sends it to the host with what the Scan decided, stripped
 * of every Value and every address's query, then shows where the Capture was
 * saved, or the host's refusal.
 */

const host = installHeldMappingHost()

const PAGE_URL = 'https://jobs.example.com/apply?token=abc123&utm_source=board'
const FRAME_URL = 'https://jobs.example.com/apply?session=s3cr3t'
const SAVED_PATH = '/home/ada/.job-form-filler/captures/2026-11-16T12-00-00-000Z-generic-1a2b3c4d.json'
const REFUSAL = 'Capture refused: after cleaning it still holds 1 home-path. Nothing was saved.'

interface CaptureAsk { frameId: number | undefined; held: { fid: number; value: string }[] }

let asks: CaptureAsk[]
let saves: Record<string, unknown>[]
let answer: (requestId: string) => HostResponse

type Chrome = {
  runtime: { sendMessage: (msg: unknown) => Promise<unknown> }
  tabs: { query: unknown; get: unknown }
}

beforeEach(() => {
  asks = []
  saves = []
  answer = (requestId) => ({ requestId, ok: true, result: { path: SAVED_PATH } })
  const chrome = (globalThis as unknown as { chrome: Chrome }).chrome
  const tab = { id: 7, url: PAGE_URL, title: 'Engineer at Example' }
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
  const relay = chrome.runtime.sendMessage
  chrome.runtime.sendMessage = async (msg: unknown) => {
    const m = msg as { kind?: string; frameId?: number; message?: { type?: string; held?: CaptureAsk['held'] } }
    if (m.kind === 'toContent' && m.message?.type === 'JFF_CAPTURE') {
      asks.push({ frameId: m.frameId, held: m.message.held ?? [] })
      return { ok: true, replies: [{ frameId: m.frameId, url: null, payload: { ok: true, capture: { html: '<!DOCTYPE html>\n<html><body><form></form></body></html>', cut: false } } }], failures: [] }
    }
    const reply = await relay(msg) as { replies?: { url?: string | null }[] }
    // The frame's own address carries a query, as a real one may.
    if (m.kind === 'toContent' && m.message?.type === 'JFF_SCAN') for (const r of reply.replies ?? []) r.url = FRAME_URL
    return reply
  }
  const bridge = window.__jffHostBridge!
  window.__jffHostBridge = async (req) => {
    if (req.method !== 'capture.save') return bridge(req)
    saves.push(req.params as Record<string, unknown>)
    return answer(req.requestId)
  }
})

const captureButton = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('[data-jff-capture]')
const captureMsg = (): string | null => document.querySelector('[data-jff-capture-msg]')?.textContent ?? null

/** Mount, wait for the auto-Scan to settle with `kind`, and press the button. */
async function scanThenCapture(kind: string): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe(kind) }, { timeout: 8_000 })
  await waitFor(() => { expect(captureButton()?.disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: 'Save a capture' }))
}

describe('the Save a capture button', () => {
  it('is not there before any Scan', async () => {
    host.fields = [field(0, 'Full name')]
    host.holdFirst = true
    render(<App />)
    await waitFor(() => { expect(host.firstRequests).toHaveLength(1) }, { timeout: 8_000 })
    expect(captureButton()).toBeNull()
  })

  it('is there after a zero-Field Scan, and saves the top frame\'s page', async () => {
    host.fields = []
    await scanThenCapture('empty')
    await waitFor(() => { expect(captureMsg()).toBe(`Capture saved to ${SAVED_PATH}`) }, { timeout: 8_000 })
    expect(asks.map((a) => a.frameId)).toEqual([0])
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({ fields: [], resolutions: [], election: null })
  }, 15_000)

  it('is there after a Scan with Fields, and shows the saved file\'s path', async () => {
    host.fields = [field(0, 'Full name')]
    host.nothingPending = true
    host.firstValues = { 0: 'Ada Lovelace' }
    await scanThenCapture('done')
    await waitFor(() => { expect(captureMsg()).toBe(`Capture saved to ${SAVED_PATH}`) }, { timeout: 8_000 })
  }, 15_000)
})

describe('the request the Side panel sends', () => {
  it('holds no current Value, and five keys on each Resolution, for one that carried a phone\'s parts, a city\'s parts and candidate wordings', async () => {
    host.fields = [
      field(0, 'Phone', { currentValue: '+44 20 7946 0100' }),
      field(1, 'City', { kind: 'combobox', currentValue: 'London' }),
    ]
    host.nothingPending = true
    host.firstValues = { 0: '+44 20 7946 0100', 1: 'London' }
    host.firstCandidates = { 0: ['United Kingdom', 'Reino Unido'] }
    host.firstPatch = {
      0: { key: 'phone', phone: { callingCode: '44', nationalNumber: '2079460100', countryNames: ['United Kingdom'] } },
      1: { key: 'city', city: { countryNames: ['United Kingdom'], region: 'England' }, candidates: ['Londres'] },
    }
    await scanThenCapture('done')
    await waitFor(() => { expect(saves).toHaveLength(1) }, { timeout: 8_000 })
    const sent = saves[0] as { fields: { currentValue: unknown }[]; resolutions: Record<string, unknown>[] }
    expect(sent.fields.map((f) => f.currentValue)).toEqual([null, null])
    expect(sent.resolutions).toHaveLength(2)
    for (const r of sent.resolutions) expect(Object.keys(r).sort()).toEqual(['handle', 'key', 'reason', 'source', 'tier'])
    expect(JSON.stringify(sent)).not.toMatch(/7946|London|Londres|United Kingdom|England/)
  }, 15_000)

  it('holds no address with a query: the page\'s, the election\'s and the frame reports\'', async () => {
    host.fields = [field(0, 'Full name')]
    host.nothingPending = true
    await scanThenCapture('done')
    await waitFor(() => { expect(saves).toHaveLength(1) }, { timeout: 8_000 })
    const sent = saves[0] as { url: string; election: { url: string | null }; frameReports: { url: string | null }[] }
    expect(sent.url).toBe('https://jobs.example.com/apply')
    expect(sent.election.url).toBe('https://jobs.example.com/apply')
    expect(sent.frameReports.length).toBeGreaterThan(0)
    for (const r of sent.frameReports) expect(r.url).toBe('https://jobs.example.com/apply')
    expect(JSON.stringify(sent)).not.toMatch(/token|utm_source|s3cr3t/)
  }, 15_000)

  it('asks the elected frame for its page with the Values the Side panel knows for it', async () => {
    host.fields = [field(0, 'Full name'), field(1, 'Location', { kind: 'combobox' })]
    host.nothingPending = true
    host.firstValues = { 0: 'Ada Lovelace', 1: 'Lisbon' }
    await scanThenCapture('done')
    await waitFor(() => { expect(asks).toHaveLength(1) }, { timeout: 8_000 })
    expect(asks[0]!.frameId).toBe(0)
    expect(asks[0]!.held).toEqual(expect.arrayContaining([{ fid: 0, value: 'Ada Lovelace' }, { fid: 1, value: 'Lisbon' }]))
  }, 15_000)
})

describe('a refused Capture', () => {
  it('shows the refusal and no saved path', async () => {
    answer = (requestId) => ({ requestId, ok: false, error: { kind: 'bad_request', message: REFUSAL } })
    host.fields = [field(0, 'Full name')]
    host.nothingPending = true
    await scanThenCapture('done')
    await waitFor(() => { expect(captureMsg()).toBe(REFUSAL) }, { timeout: 8_000 })
    expect(captureMsg()).not.toContain(SAVED_PATH)
  }, 15_000)
})
