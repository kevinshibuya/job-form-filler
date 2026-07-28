import { describe, it, expect, vi } from 'vitest'
import type { ContentMessage, EnumField, Resolution } from '@jff/shared'
import type { HostPort } from './port'
import { runScan, type ScanDeps } from './scan'

const field = (frameId: number, fid: number, patch: Partial<EnumField> = {}): EnumField => ({
  frameId: -1, fid, epoch: 0, label: `L${fid}`, name: `n${fid}`, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

function makeDeps(over: Partial<ScanDeps> = {}) {
  const sent: ContentMessage[] = []
  let epoch = 0
  const scanReply = (frameId: number, fields: EnumField[]) => ({
    frameId, payload: { ok: true, scan: { epoch, fields, unreachableWidgets: 0, activeCaptcha: false } },
  })
  const deps: ScanDeps = {
    tabId: 1,
    nextEpoch: () => ++epoch,
    inject: vi.fn(async () => [0]),
    sendToTab: vi.fn(async (_frameId, message) => {
      if (message.type === 'JFF_SCAN') return [scanReply(0, [field(0, 0), field(0, 1, { kind: 'file' })])]
      if (message.type === 'JFF_JOBTEXT') return [{ frameId: 0, payload: { ok: true, jobText: { text: 'JD TEXT', selector: '#jd', source: 'heuristic' } } }]
      if (message.type === 'JFF_FILL_RESUME') return [{ frameId: 0, payload: { ok: true } }]
      if (message.type === 'JFF_FILL') return [{ frameId: 0, payload: { ok: true, fill: { epoch, filled: [], failed: [] } } }]
      return [{ frameId: 0, payload: { ok: false } }]
    }),
    // `request` is generic on HostPort, so the stub needs an explicit cast at the
    // end of this object literal (`as unknown as HostPort`). Same everywhere below.
    port: {
      request: vi.fn(async (method: string) => {
        if (method === 'selector.get') return { ok: true, result: { selector: null } }
        if (method === 'resolve') {
          const resolutions: Resolution[] = [
            { handle: { frameId: 0, fid: 0, epoch }, tier: 'auto', value: 'V0', source: 'profile', key: 'email', answerId: null, reason: 'recognizer:email' },
          ]
          return { ok: true, result: { epoch, resolutions, llmError: null } }
        }
        return { ok: true, result: {} }
      }),
      onDisconnect: () => undefined,
      disconnect: () => undefined,
    } as unknown as HostPort,
    getResume: async () => ({ name: 'cv.pdf', mimeType: 'application/pdf', dataBase64: 'AAA=' }),
    pastedJobText: '',
    ...over,
  }
  // Record AFTER merging `over`, not inside the default stub. Several tests below
  // replace sendToTab wholesale; if only the default stub logged, their
  // `expect(sent).not.toContain('JFF_FILL')` would pass against an empty array —
  // a vacuously green assertion on the "never fill under a live CAPTCHA" rule.
  const inner = deps.sendToTab
  deps.sendToTab = vi.fn(async (frameId, message) => { sent.push(message); return inner(frameId, message) })
  return { deps, sent }
}

describe('runScan', () => {
  it('injects the content script before doing anything else', async () => {
    const { deps } = makeDeps()
    await runScan(deps)
    expect(deps.inject).toHaveBeenCalledTimes(1)
  })

  it('fills the RESUME before the resolve call and re-enumerates afterwards', async () => {
    const { deps, sent } = makeDeps()
    await runScan(deps)
    const order = sent.map((m) => m.type)
    expect(order.indexOf('JFF_FILL_RESUME')).toBeLessThan(order.lastIndexOf('JFF_SCAN'))
    expect(order.filter((t) => t === 'JFF_SCAN')).toHaveLength(2) // enumerate, then RE-enumerate
    expect(order.indexOf('JFF_FILL')).toBeGreaterThan(order.lastIndexOf('JFF_SCAN'))
  })

  it('uses a NEW epoch for the re-enumeration', async () => {
    const { deps, sent } = makeDeps()
    const out = await runScan(deps)
    const scans = sent.filter((m) => m.type === 'JFF_SCAN') as { epoch: number }[]
    expect(scans[1]!.epoch).toBeGreaterThan(scans[0]!.epoch)
    expect(out.epoch).toBe(scans[1]!.epoch)
  })

  it('stamps frameId onto every field from the reply envelope', async () => {
    const { deps } = makeDeps()
    const out = await runScan(deps)
    expect(out.fields.every((f) => f.frameId === 0)).toBe(true)
  })

  it('skips the resume phase entirely when no resume is stored', async () => {
    const { deps, sent } = makeDeps({ getResume: async () => null })
    await runScan(deps)
    expect(sent.map((m) => m.type)).not.toContain('JFF_FILL_RESUME')
    expect(sent.filter((m) => m.type === 'JFF_SCAN')).toHaveLength(1) // no re-enumeration needed
  })

  it('skips the resume phase when the page has no file input', async () => {
    const { deps, sent } = makeDeps({
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') return [{ frameId: 0, payload: { ok: true, scan: { epoch: 1, fields: [field(0, 0)], unreachableWidgets: 0, activeCaptcha: false } } }]
        if (message.type === 'JFF_JOBTEXT') return [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }]
        return [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [] } } }]
      }),
    })
    await runScan(deps)
    expect(sent.map((m) => m.type)).not.toContain('JFF_FILL_RESUME')
  })

  it('prefers pasted job text over scraping and never asks the page for it', async () => {
    const { deps, sent } = makeDeps({ pastedJobText: 'PASTED JD' })
    const out = await runScan(deps)
    expect(out.jobText).toBe('PASTED JD')
    expect(sent.map((m) => m.type)).not.toContain('JFF_JOBTEXT')
  })

  it('saves a newly discovered job_description selector for this hostname', async () => {
    const { deps } = makeDeps()
    await runScan(deps)
    expect(deps.port.request).toHaveBeenCalledWith('selector.save', expect.objectContaining({ selector: '#jd', purpose: 'job_description' }))
  })

  it('auto-fills only tier=auto resolutions and never page-sourced ones', async () => {
    const { deps, sent } = makeDeps({
      port: {
        request: vi.fn(async (method: string) => {
          if (method === 'selector.get') return { ok: true, result: { selector: null } }
          if (method === 'resolve') return {
            ok: true,
            result: {
              epoch: 2, llmError: null,
              resolutions: [
                { handle: { frameId: 0, fid: 0, epoch: 2 }, tier: 'auto', value: 'FILL ME', source: 'profile', key: 'email', answerId: null, reason: 'r' },
                { handle: { frameId: 0, fid: 1, epoch: 2 }, tier: 'auto', value: 'ALREADY THERE', source: 'page', key: null, answerId: null, reason: 'already-on-page' },
                { handle: { frameId: 0, fid: 2, epoch: 2 }, tier: 'proposed', value: 'ASK FIRST', source: 'llm_key', key: 'salary', answerId: null, reason: 'r' },
              ],
            },
          }
          return { ok: true, result: {} }
        }),
        onDisconnect: () => undefined,
        disconnect: () => undefined,
      } as unknown as HostPort,
    })
    await runScan(deps)
    const fill = sent.find((m) => m.type === 'JFF_FILL') as { fills: { value: string }[] }
    expect(fill.fills.map((f) => f.value)).toEqual(['FILL ME'])
  })

  it('surfaces an llmError from the host without throwing', async () => {
    const { deps } = makeDeps({
      port: {
        request: vi.fn(async (method: string) => {
          if (method === 'selector.get') return { ok: true, result: { selector: null } }
          if (method === 'resolve') return { ok: true, result: { epoch: 2, resolutions: [], llmError: { kind: 'rate_limit', message: 'limit' } } }
          return { ok: true, result: {} }
        }),
        onDisconnect: () => undefined,
        disconnect: () => undefined,
      } as unknown as HostPort,
    })
    const out = await runScan(deps)
    expect(out.llmError).toEqual({ kind: 'rate_limit', message: 'limit' })
  })

  it('reports an active CAPTCHA and fills NOTHING', async () => {
    const { deps, sent } = makeDeps({
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') return [{ frameId: 0, payload: { ok: true, scan: { epoch: 1, fields: [field(0, 0)], unreachableWidgets: 0, activeCaptcha: true } } }]
        return [{ frameId: 0, payload: { ok: true } }]
      }),
    })
    const out = await runScan(deps)
    expect(out.activeCaptcha).toBe(true)
    expect(sent.map((m) => m.type)).not.toContain('JFF_FILL')
  })

  it('aborts phase 2 when a CAPTCHA appears only after the resume upload', async () => {
    // Uploading a resume is exactly the moment an ATS decides to challenge you.
    // The re-enumeration already re-reads activeCaptcha; ignoring the new value
    // would fill the whole form underneath a live challenge.
    let scans = 0
    const { deps, sent } = makeDeps({
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          scans++
          return [{ frameId: 0, payload: { ok: true, scan: {
            epoch: scans, fields: [field(0, 0), field(0, 1, { kind: 'file' })],
            unreachableWidgets: 0, activeCaptcha: scans > 1,
          } } }]
        }
        if (message.type === 'JFF_JOBTEXT') return [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }]
        return [{ frameId: 0, payload: { ok: true } }]
      }),
    })
    const out = await runScan(deps)
    expect(scans).toBe(2)
    expect(out.activeCaptcha).toBe(true)
    expect(out.resolutions).toEqual([])
    expect(sent.map((m) => m.type)).not.toContain('JFF_FILL')
    expect(deps.port.request).not.toHaveBeenCalledWith('resolve', expect.anything())
  })
})
