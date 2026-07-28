import { describe, it, expect, vi } from 'vitest'
import type { ContentMessage, EnumField, Resolution } from '@jff/shared'
import type { HostPort } from './port'
import { runScan, ScanError, type ScanDeps } from './scan'

const field = (frameId: number, fid: number, patch: Partial<EnumField> = {}): EnumField => ({
  frameId: -1, fid, epoch: 0, label: `L${fid}`, name: `n${fid}`, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

function makeDeps(over: Partial<ScanDeps> = {}) {
  const sent: ContentMessage[] = []
  const phases: string[] = []
  let epoch = 0
  const scanReply = (frameId: number, fields: EnumField[]) => ({
    frameId, url: 'https://ats.example/apply',
    payload: { ok: true, scan: { epoch, fields, unreachableWidgets: 0, activeCaptcha: false } },
  })
  const deps: ScanDeps = {
    tabId: 1,
    nextEpoch: () => ++epoch,
    inject: vi.fn(async () => [0]),
    sendToTab: vi.fn(async (_frameId, message) => {
      if (message.type === 'JFF_SCAN') return { replies: [scanReply(0, [field(0, 0), field(0, 1, { kind: 'file' })])], failures: [] }
      if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: 'JD TEXT', selector: '#jd', source: 'heuristic' } } }], failures: [] }
      if (message.type === 'JFF_FILL_RESUME') return { replies: [{ frameId: 0, payload: { ok: true } }], failures: [] }
      if (message.type === 'JFF_FILL') return { replies: [{ frameId: 0, payload: { ok: true, fill: { epoch, filled: [], failed: [] } } }], failures: [] }
      return { replies: [{ frameId: 0, payload: { ok: false } }], failures: [] }
    }),
    onProgress: vi.fn((p) => phases.push(p.phase)),
    sleep: vi.fn(async () => undefined),
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
  return { deps, sent, phases }
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
        if (message.type === 'JFF_SCAN') return { replies: [{ frameId: 0, payload: { ok: true, scan: { epoch: 1, fields: [field(0, 0)], unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        return { replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [] } } }], failures: [] }
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
        if (message.type === 'JFF_SCAN') return { replies: [{ frameId: 0, payload: { ok: true, scan: { epoch: 1, fields: [field(0, 0)], unreachableWidgets: 0, activeCaptcha: true } } }], failures: [] }
        return { replies: [{ frameId: 0, payload: { ok: true } }], failures: [] }
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
          return { replies: [{ frameId: 0, payload: { ok: true, scan: {
            epoch: scans, fields: [field(0, 0), field(0, 1, { kind: 'file' })],
            unreachableWidgets: 0, activeCaptcha: scans > 1,
          } } }], failures: [] }
        }
        if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        return { replies: [{ frameId: 0, payload: { ok: true } }], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(scans).toBe(2)
    expect(out.activeCaptcha).toBe(true)
    expect(out.resolutions).toEqual([])
    expect(sent.map((m) => m.type)).not.toContain('JFF_FILL')
    expect(deps.port.request).not.toHaveBeenCalledWith('resolve', expect.anything())
  })

  it('emits injecting -> enumerating -> resolving on the happy path', async () => {
    const { deps, phases } = makeDeps({ getResume: async () => null })
    await runScan(deps)
    expect(phases).toEqual(['injecting', 'enumerating', 'resolving'])
    expect(deps.onProgress).toHaveBeenCalledWith({ phase: 'enumerating', frames: 1 })
    expect(deps.onProgress).toHaveBeenCalledWith({ phase: 'resolving', fields: 2 })
  })

  it('re-emits injecting/enumerating around the resume re-enumeration', async () => {
    const { deps, phases } = makeDeps()
    await runScan(deps)
    // resume path: inject, enumerate, (resume fill), enumerate again, resolve
    expect(phases).toEqual(['injecting', 'enumerating', 'enumerating', 'resolving'])
  })

  it('retries the enumeration ONCE after a delay when it finds zero fields', async () => {
    let calls = 0
    const { deps, phases } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          calls++
          const fields = calls === 1 ? [] : [field(0, 0)]
          return { replies: [{ frameId: 0, url: 'https://ats.example/apply', payload: { ok: true, scan: { epoch: 1, fields, unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        }
        if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        return { replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [] } } }], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(deps.sleep).toHaveBeenCalledWith(1_500)
    expect(deps.inject).toHaveBeenCalledTimes(2)
    expect(phases).toEqual(['injecting', 'enumerating', 'retrying', 'injecting', 'enumerating', 'resolving'])
    expect(out.fields).toHaveLength(1)
  })

  it('returns the empty outcome WITHOUT any host call when both enumerations are empty', async () => {
    const { deps } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') return { replies: [{ frameId: 0, url: 'https://top.example/', payload: { ok: true, scan: { epoch: 1, fields: [], unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(out.fields).toEqual([])
    expect(out.resolutions).toEqual([])
    expect(out.frameReports).toEqual([{ frameId: 0, url: 'https://top.example/', fields: 0, error: null }])
    // No selector.get, no resolve: an empty page must cost zero host round-trips.
    expect(deps.port.request).not.toHaveBeenCalled()
  })

  it('propagates a relay failure instead of swallowing it into an empty scan', async () => {
    const { deps, phases } = makeDeps({
      sendToTab: vi.fn(async () => { throw new Error('background relay dead') }),
    })
    await expect(runScan(deps)).rejects.toThrow('background relay dead')
    // The failure happened DURING enumeration; no phase may be emitted after it.
    expect(phases).toEqual(['injecting', 'enumerating'])
  })

  it('keeps first-attempt frame errors as evidence across the retry', async () => {
    let calls = 0
    const { deps } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          calls++
          if (calls === 1) {
            return { replies: [{ frameId: 0, url: 'https://top.example/', payload: { ok: false, error: 'bad_scan' } }], failures: [] }
          }
          return { replies: [{ frameId: 0, url: 'https://top.example/', payload: { ok: true, scan: { epoch: 1, fields: [], unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        }
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(out.frameReports).toEqual([
      { frameId: 0, url: 'https://top.example/', fields: null, error: 'bad_scan' },
      { frameId: 0, url: 'https://top.example/', fields: 0, error: null },
    ])
  })

  it('reports a failed auto-fill send in frameReports instead of discarding the scan', async () => {
    const { deps } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') return { replies: [{ frameId: 0, url: null, payload: { ok: true, scan: { epoch: 1, fields: [field(0, 0)], unreachableWidgets: 0, activeCaptcha: false } } }], failures: [] }
        if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        if (message.type === 'JFF_FILL') throw new Error('frame gone')
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(out.resolutions).toHaveLength(1) // the scan and its paid resolve survived
    expect(out.frameReports.some((r) => r.error !== null && r.error.includes('fill failed'))).toBe(true)
  })

  it('reports per-frame errors and broadcast failures in frameReports', async () => {
    const { deps } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          return {
            replies: [
              { frameId: 0, url: 'https://top.example/', payload: { ok: true, scan: { epoch: 1, fields: [field(0, 0)], unreachableWidgets: 0, activeCaptcha: false } } },
              { frameId: 3, url: 'https://weird.example/', payload: { ok: false, error: 'bad_scan' } },
            ],
            failures: [{ frameId: 7, url: 'https://ats.example/embed', error: 'no receiver' }],
          }
        }
        if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(out.frameReports).toEqual([
      { frameId: 7, url: 'https://ats.example/embed', fields: null, error: 'no receiver' },
      { frameId: 0, url: 'https://top.example/', fields: 1, error: null },
      { frameId: 3, url: 'https://weird.example/', fields: null, error: 'bad_scan' },
    ])
  })

  it('carries activeCaptcha through the empty outcome and does NOT retry past it', async () => {
    // The retry's 1.5s delay is exactly long enough for a challenge frame to churn.
    // Retrying could find fields with activeCaptcha back to false — and then fill
    // past a challenge this scan already observed.
    const { deps, phases } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') return { replies: [{ frameId: 0, url: null, payload: { ok: true, scan: { epoch: 1, fields: [], unreachableWidgets: 0, activeCaptcha: true } } }], failures: [] }
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(out.activeCaptcha).toBe(true)
    expect(out.fields).toEqual([])
    expect(phases).toEqual(['injecting', 'enumerating'])
    expect(deps.inject).toHaveBeenCalledTimes(1)
    expect(deps.sleep).not.toHaveBeenCalled()
    expect(deps.port.request).not.toHaveBeenCalled()
  })

  it('does not resolve when a captcha-free retry would have found fields but the first pass was challenged', async () => {
    // Mutation probe for the guard above: without it the second pass (fields, no
    // captcha) sails straight into a paid resolve and a full auto-fill.
    let calls = 0
    const { deps, sent } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          calls++
          return { replies: [{ frameId: 0, url: null, payload: { ok: true, scan: {
            epoch: 1, fields: calls === 1 ? [] : [field(0, 0)],
            unreachableWidgets: 0, activeCaptcha: calls === 1,
          } } }], failures: [] }
        }
        return { replies: [], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(calls).toBe(1)
    expect(out.activeCaptcha).toBe(true)
    expect(sent.map((m) => m.type)).not.toContain('JFF_FILL')
    expect(deps.port.request).not.toHaveBeenCalledWith('resolve', expect.anything())
  })

  it('never resolves when the post-resume re-enumeration comes back empty', async () => {
    // The resume upload can navigate the frame out from under us. PHASE 0's
    // "zero fields costs zero host round-trips" rule holds here too.
    let scans = 0
    const { deps, phases } = makeDeps({
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          scans++
          return { replies: [{ frameId: 0, url: 'https://ats.example/apply', payload: { ok: true, scan: {
            epoch: scans, fields: scans === 1 ? [field(0, 0, { kind: 'file' })] : [],
            unreachableWidgets: 0, activeCaptcha: false,
          } } }], failures: [] }
        }
        if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
        return { replies: [{ frameId: 0, payload: { ok: true } }], failures: [] }
      }),
    })
    const out = await runScan(deps)
    expect(scans).toBe(2)
    expect(out.fields).toEqual([])
    expect(out.resolutions).toEqual([])
    expect(phases).toEqual(['injecting', 'enumerating', 'enumerating'])
    expect(deps.port.request).not.toHaveBeenCalledWith('resolve', expect.anything())
  })

  it('throws a ScanError carrying the enumeration evidence when a later step dies', async () => {
    const { deps } = makeDeps({
      getResume: async () => null,
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          return {
            replies: [{ frameId: 0, url: 'https://top.example/', payload: { ok: true, scan: { epoch: 1, fields: [field(0, 0)], unreachableWidgets: 0, activeCaptcha: false } } }],
            failures: [{ frameId: 7, url: 'https://ats.example/embed', error: 'no receiver' }],
          }
        }
        throw new Error('relay died mid-scan')
      }),
    })
    const err = await runScan(deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ScanError)
    expect((err as ScanError).message).toBe('relay died mid-scan')
    // The evidence the enumeration already paid for survives the failure.
    expect((err as ScanError).frameReports).toEqual([
      { frameId: 7, url: 'https://ats.example/embed', fields: null, error: 'no receiver' },
      { frameId: 0, url: 'https://top.example/', fields: 1, error: null },
    ])
  })
})
