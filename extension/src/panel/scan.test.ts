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
      // The file field carries a SCORING label on purpose: under A8 the resume
      // target is picked by score, so an unlabelled file input would silently
      // remove the resume phase from every test that leans on this default.
      if (message.type === 'JFF_SCAN') return { replies: [scanReply(0, [field(0, 0), field(0, 1, { kind: 'file', label: 'Resume' })])], failures: [] }
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

/** File-scope on purpose: plan 3 Task 4's B3 describe reuses it. */
function depsWithFields(fields: ReturnType<typeof field>[], resolveTier: 'auto' | 'needs_input' = 'needs_input') {
  const made = makeDeps()
  let epoch = 0
  made.deps.nextEpoch = () => ++epoch
  // `made.deps.sendToTab` IS makeDeps' recording wrapper (it pushes to `sent`
  // itself). So delegate to it for everything we do not answer here, and push
  // ONLY the one message we answer without delegating (JFF_SCAN) — pushing
  // unconditionally here would leave `sent` holding every fill TWICE and quietly
  // break any length-based assertion.
  const inner = made.deps.sendToTab
  made.deps.sendToTab = vi.fn(async (frameId, message) => {
    if (message.type === 'JFF_SCAN') {
      made.sent.push(message)
      return {
        replies: [{ frameId: 0, url: 'https://ats.example/apply', payload: { ok: true, scan: { epoch, fields, unreachableWidgets: 0, activeCaptcha: false } } }],
        failures: [],
      }
    }
    return inner(frameId, message)
  })
  made.deps.getResume = async () => null
  const resolveCalls: unknown[] = []
  made.deps.port = {
    request: vi.fn(async (method: string, params: unknown) => {
      if (method === 'selector.get') return { ok: true, result: { selector: null } }
      if (method === 'resolve') {
        resolveCalls.push(params)
        const p = params as { fields: { frameId: number; fid: number }[] }
        return {
          ok: true,
          result: {
            epoch,
            resolutions: p.fields.map((f) => ({
              handle: { frameId: f.frameId, fid: f.fid, epoch }, tier: resolveTier,
              value: resolveTier === 'auto' ? 'V' : null,
              source: null, key: null, answerId: null, reason: 'test',
            })),
            llmError: null,
          },
        }
      }
      return { ok: true, result: {} }
    }),
    onDisconnect: () => undefined,
    disconnect: () => undefined,
  } as unknown as HostPort
  return { ...made, resolveCalls }
}

/** File scope on purpose: BOTH the A7 election describe and the A6 harvest
 *  describe use `twoFrameDeps`, and it closes over `topFields`/`appFields`. */
const topFields = [field(0, 0, { label: 'Newsletter email', name: 'email' })]
const appFields = (extra: EnumField[] = []) => [
  field(1, 0, { label: 'First name' }),
  field(1, 1, { label: 'Why us?', required: true }),
  field(1, 2, { label: 'Resume', kind: 'file' }),
  ...extra,
]

function twoFrameDeps(over: {
  app?: EnumField[]
  resume?: boolean
  pasted?: string
  harvestReply?: unknown
} = {}) {
  const made = makeDeps()
  let epoch = 0
  made.deps.nextEpoch = () => ++epoch
  made.deps.pastedJobText = over.pasted ?? ''
  made.deps.getResume = async () =>
    over.resume === true ? { name: 'cv.pdf', mimeType: 'application/pdf', dataBase64: 'AAA=' } : null
  made.deps.inject = vi.fn(async () => [0, 1])
  const app = over.app ?? appFields()
  made.deps.sendToTab = vi.fn(async (frameId, message) => {
    made.sent.push(message)
    if (message.type === 'JFF_SCAN') {
      return {
        replies: [
          { frameId: 0, url: 'https://careers.example/', payload: { ok: true, scan: { epoch, fields: topFields, unreachableWidgets: 0, activeCaptcha: false } } },
          { frameId: 1, url: 'https://ats.example/embed', payload: { ok: true, scan: { epoch, fields: app, unreachableWidgets: 0, activeCaptcha: false } } },
        ],
        failures: [],
      }
    }
    if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
    if (message.type === 'JFF_HARVEST') {
      return { replies: [{ frameId: 1, payload: over.harvestReply ?? { ok: true, options: {} } }], failures: [] }
    }
    return { replies: [{ frameId: frameId ?? 0, payload: { ok: true, fill: { epoch, filled: [], failed: [] } } }], failures: [] }
  })
  const resolveCalls: { fields: EnumField[] }[] = []
  made.deps.port = {
    request: vi.fn(async (method: string, params: unknown) => {
      if (method === 'selector.get') return { ok: true, result: { selector: null } }
      if (method === 'resolve') {
        const p = params as { fields: EnumField[] }
        resolveCalls.push(p)
        return {
          ok: true,
          result: {
            epoch,
            resolutions: p.fields.map((f) => ({
              handle: { frameId: f.frameId, fid: f.fid, epoch }, tier: 'auto',
              value: 'V', source: 'profile', key: null, answerId: null, reason: 'test',
            })),
            llmError: null,
          },
        }
      }
      return { ok: true, result: {} }
    }),
    onDisconnect: () => undefined,
    disconnect: () => undefined,
  } as unknown as HostPort
  return { ...made, resolveCalls }
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
            // Scoring label: this test's subject is the post-upload captcha
            // abort, so the A8 scorer must actually pick the file field.
            epoch: scans, fields: [field(0, 0), field(0, 1, { kind: 'file', label: 'Resume' })],
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

  it('keeps the first-pass evidence when the RETRY itself dies on the relay', async () => {
    // The retry is the one leg that used to run outside the ScanError contract:
    // a relay death there threw a bare Error and the panel lost the first pass's
    // rows — the exact evidence that explains an empty enumeration.
    let injects = 0
    const { deps } = makeDeps({
      getResume: async () => null,
      inject: vi.fn(async () => {
        injects++
        if (injects === 2) throw new Error('relay died during the retry')
        return [0]
      }),
      sendToTab: vi.fn(async (_f, message: ContentMessage) => {
        if (message.type === 'JFF_SCAN') {
          return { replies: [{ frameId: 0, url: 'https://top.example/', payload: { ok: false, error: 'bad_scan' } }], failures: [] }
        }
        return { replies: [], failures: [] }
      }),
    })
    const err = await runScan(deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ScanError)
    expect((err as ScanError).message).toBe('relay died during the retry')
    expect((err as ScanError).frameReports).toEqual([
      { frameId: 0, url: 'https://top.example/', fields: null, error: 'bad_scan' },
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
            // Scoring label for the same reason as above: the subject is the
            // empty post-resume re-enumeration, not resume targeting.
            epoch: scans, fields: scans === 1 ? [field(0, 0, { kind: 'file', label: 'Resume' })] : [],
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

describe('runScan — A5 junk filtering', () => {
  const junkAnd2 = [
    field(0, 0),
    field(0, 1, { kind: 'textarea', visible: false, label: null, name: 'g-recaptcha-response' }),
    field(0, 2, { kind: 'choice', visible: false, label: 'Authorized?', options: ['Yes', 'No'] }),
  ]

  it('excludes visible:false junk from the resolve payload, the fill loop and the returned fields', async () => {
    const { deps, sent, resolveCalls } = depsWithFields(junkAnd2, 'auto')
    const out = await runScan(deps)
    const resolved = resolveCalls[0] as { fields: { fid: number }[] }
    expect(resolved.fields.map((f) => f.fid)).toEqual([0, 2]) // recaptcha fid 1 never leaves the panel
    expect(out.fields.map((f) => f.fid)).toEqual([0, 2])
    const fills = sent.filter((m) => m.type === 'JFF_FILL') as { fills: { handle: { fid: number } }[] }[]
    for (const m of fills) expect(m.fills.every((x) => x.handle.fid !== 1)).toBe(true)
  })

  it('sends choice resolutions through the batch fill (interim guard deleted — fillChoice owns them now)', async () => {
    const { deps, sent } = depsWithFields(junkAnd2, 'auto')
    await runScan(deps)
    const fills = sent.filter((m) => m.type === 'JFF_FILL') as { fills: { handle: { fid: number } }[] }[]
    expect(fills.length).toBeGreaterThan(0)
    expect(fills.some((m) => m.fills.some((x) => x.handle.fid === 2))).toBe(true) // the choice fid IS filled
  })

  it('returns without calling resolve when only junk remains', async () => {
    const onlyJunk = [field(0, 0, { kind: 'textarea', visible: false, label: null })]
    const { deps, resolveCalls } = depsWithFields(onlyJunk)
    const out = await runScan(deps)
    expect(resolveCalls).toHaveLength(0)
    expect(out.fields).toEqual([])
    expect(out.resolutions).toEqual([])
  })

  it('keeps a hidden labelled file input as a resume target', async () => {
    const withHiddenFile = [field(0, 0), field(0, 1, { kind: 'file', visible: false, label: 'Resume' })]
    const { deps, sent } = depsWithFields(withHiddenFile)
    deps.getResume = async () => ({ name: 'cv.pdf', mimeType: 'application/pdf', dataBase64: 'AAA=' })
    await runScan(deps)
    expect(sent.some((m) => m.type === 'JFF_FILL_RESUME')).toBe(true)
  })
})

describe('runScan — A7 frame election', () => {
  it('elects the frame with the most signal and scopes resolve to it', async () => {
    const { deps, resolveCalls } = twoFrameDeps()
    const out = await runScan(deps)
    expect(out.election).toEqual({ frameId: 1, score: 11, url: 'https://ats.example/embed' }) // 3 + 3×1 + 5
    expect(resolveCalls[0]!.fields.every((f) => f.frameId === 1)).toBe(true)
    // Foreign fields are KEPT in the outcome; the panel demotes them.
    expect(out.fields.map((f) => `${f.frameId}:${f.fid}`)).toEqual(['0:0', '1:0', '1:1', '1:2'])
  })

  it('never auto-fills the recognizer-resolvable newsletter field in the non-elected frame', async () => {
    const { deps, sent } = twoFrameDeps()
    await runScan(deps)
    const fills = sent.filter((m) => m.type === 'JFF_FILL') as { fills: { handle: { frameId: number } }[] }[]
    expect(fills.length).toBeGreaterThan(0)
    for (const m of fills) expect(m.fills.every((x) => x.handle.frameId === 1)).toBe(true)
  })

  it('election still picks the form frame when the user pasted job text', async () => {
    const { deps, sent, resolveCalls } = twoFrameDeps({ pasted: 'PASTED JD' })
    const out = await runScan(deps)
    expect(out.election!.frameId).toBe(1)
    expect(out.jobText).toBe('PASTED JD')
    expect(sent.map((m) => m.type)).not.toContain('JFF_JOBTEXT')
    expect(resolveCalls[0]!.fields.every((f) => f.frameId === 1)).toBe(true)
  })

  it('uploads the resume to the A8 scorer pick in the elected frame, by its own fid', async () => {
    const { deps, sent } = twoFrameDeps({ resume: true })
    await runScan(deps)
    const up = sent.find((m) => m.type === 'JFF_FILL_RESUME') as { handle: { frameId: number; fid: number } }
    expect(up.handle).toMatchObject({ frameId: 1, fid: 2 })
  })

  it('does NOT upload when no elected file field scores positive', async () => {
    const app = [field(1, 0, { label: 'First name' }), field(1, 1, { kind: 'file', label: null })]
    const { deps, sent } = twoFrameDeps({ app, resume: true })
    await runScan(deps)
    expect(sent.map((m) => m.type)).not.toContain('JFF_FILL_RESUME')
  })

  it('does NOT upload to a resume-looking file field in a NON-elected frame', async () => {
    // The scoring file input lives in frame 0; frame 1 still wins the election.
    const topWithFile = [field(0, 0, { label: 'Resume', kind: 'file' })]
    const app = [field(1, 0, { required: true }), field(1, 1, { required: true }), field(1, 2)]
    const made = twoFrameDeps({ resume: true, app })
    made.deps.sendToTab = vi.fn(async (frameId, message) => {
      made.sent.push(message)
      if (message.type === 'JFF_SCAN') {
        return { replies: [
          { frameId: 0, url: 'https://careers.example/', payload: { ok: true, scan: { epoch: 1, fields: topWithFile, unreachableWidgets: 0, activeCaptcha: false } } },
          { frameId: 1, url: 'https://ats.example/embed', payload: { ok: true, scan: { epoch: 1, fields: app, unreachableWidgets: 0, activeCaptcha: false } } },
        ], failures: [] }
      }
      if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      return { replies: [{ frameId: frameId ?? 0, payload: { ok: true, fill: { epoch: 1, filled: [], failed: [] } } }], failures: [] }
    })
    const out = await runScan(made.deps)
    expect(out.election!.frameId).toBe(1) // 1+3 + 1+3 + 1 = 9 beats 1 + 5 = 6
    expect(made.sent.map((m) => m.type)).not.toContain('JFF_FILL_RESUME')
  })
})

describe('runScan — A6 combobox harvest', () => {
  const comboApp = [
    field(1, 0, { label: 'First name' }),
    field(1, 1, { label: 'Country', kind: 'combobox', options: [] }),
    field(1, 2, { label: 'Gender', kind: 'combobox', options: [], demographic: true }),
    field(1, 3, { label: 'Level', kind: 'combobox', options: ['Junior', 'Senior'] }),
    field(1, 4, { label: 'Resume', kind: 'file', required: true }),
  ]

  it('harvests only elected, non-demographic, empty-options comboboxes and merges BEFORE resolve', async () => {
    const { deps, sent, resolveCalls } = twoFrameDeps({
      app: comboApp,
      harvestReply: { ok: true, options: { 1: ['Brazil', 'Portugal'] } },
    })
    const out = await runScan(deps)
    const harvests = sent.filter((m) => m.type === 'JFF_HARVEST') as { fids: number[] }[]
    expect(harvests).toHaveLength(1)
    expect(harvests[0]!.fids).toEqual([1]) // never the demographic one, never the pre-optioned one
    // merged into the resolve payload (the prompt sees the closed set)…
    const resolvedCombo = resolveCalls[0]!.fields.find((f) => f.fid === 1)!
    expect(resolvedCombo.options).toEqual(['Brazil', 'Portugal'])
    // …and into the returned fields for rendering.
    expect(out.fields.find((f) => f.frameId === 1 && f.fid === 1)!.options).toEqual(['Brazil', 'Portugal'])
  })

  it('sends the harvest to the ELECTED frame only', async () => {
    const { deps } = twoFrameDeps({ app: comboApp, harvestReply: { ok: true, options: {} } })
    await runScan(deps)
    const call = vi.mocked(deps.sendToTab).mock.calls
      .find((c) => (c[1] as ContentMessage).type === 'JFF_HARVEST')!
    expect(call[0]).toBe(1)
  })

  it('skips the harvest message entirely when nothing qualifies', async () => {
    const { deps, sent } = twoFrameDeps() // default appFields: no comboboxes
    await runScan(deps)
    expect(sent.map((m) => m.type)).not.toContain('JFF_HARVEST')
  })

  it('a dead harvest relay degrades to empty options and the scan survives with evidence', async () => {
    const made = twoFrameDeps({ app: comboApp })
    const inner = made.deps.sendToTab
    made.deps.sendToTab = vi.fn(async (frameId, message) => {
      if (message.type === 'JFF_HARVEST') throw new Error('frame vanished mid-harvest')
      return inner(frameId, message)
    })
    const out = await runScan(made.deps)
    expect(out.resolutions.length).toBeGreaterThan(0) // the paid resolve still happened
    expect(out.fields.find((f) => f.frameId === 1 && f.fid === 1)!.options).toEqual([])
    expect(out.frameReports.some((r) => r.error !== null && r.error.includes('harvest failed'))).toBe(true)
  })

  it('a refused harvest reply (stale epoch) merges nothing and fails nothing', async () => {
    const { deps, resolveCalls } = twoFrameDeps({ app: comboApp, harvestReply: { ok: false, error: 'stale_epoch' } })
    const out = await runScan(deps)
    expect(resolveCalls).toHaveLength(1)
    expect(out.fields.find((f) => f.frameId === 1 && f.fid === 1)!.options).toEqual([])
  })

  it('runs harvest AFTER the resume re-enumeration and before resolve', async () => {
    const { deps, sent, resolveCalls } = twoFrameDeps({
      app: comboApp, resume: true,
      harvestReply: { ok: true, options: { 1: ['Brazil'] } },
    })
    await runScan(deps)
    const types = sent.map((m) => m.type)
    expect(types.indexOf('JFF_HARVEST')).toBeGreaterThan(types.lastIndexOf('JFF_SCAN'))
    expect(types.indexOf('JFF_HARVEST')).toBeGreaterThan(types.indexOf('JFF_FILL_RESUME'))
    expect(resolveCalls[0]!.fields.find((f) => f.fid === 1)!.options).toEqual(['Brazil'])
  })
})

describe('runScan — B3 fill report collection', () => {
  const twoAuto = [field(0, 0), field(0, 1, { kind: 'choice', visible: false, label: 'Authorized?', options: ['Yes', 'No'] })]

  /** Wraps depsWithFields so JFF_FILL answers with a scripted per-frame report. */
  function reportingDeps(reply: (fills: { handle: { frameId: number; fid: number; epoch: number } }[], epoch: number) => unknown) {
    const made = depsWithFields(twoAuto, 'auto')
    const inner = made.deps.sendToTab
    made.deps.sendToTab = vi.fn(async (frameId, message) => {
      if (message.type === 'JFF_FILL') {
        made.sent.push(message)
        return { replies: [{ frameId: frameId ?? 0, payload: reply(message.fills, message.epoch) }], failures: [] }
      }
      return inner(frameId, message)
    })
    return made
  }

  it('collects page-accepted and failed fills from the JFF_FILL reports', async () => {
    const { deps } = reportingDeps((fills, epoch) => ({
      ok: true,
      fill: {
        epoch,
        filled: [{ handle: fills[0]!.handle, committed: null }],
        failed: [{ handle: fills[1]!.handle, reason: 'choice-needs-user-click' }],
      },
    }))
    const out = await runScan(deps)
    expect(out.fill.filled).toEqual([{ handle: expect.objectContaining({ frameId: 0, fid: 0 }), committed: null }])
    expect(out.fill.failed).toEqual([
      { handle: expect.objectContaining({ frameId: 0, fid: 1 }), reason: 'choice-needs-user-click' },
    ])
  })

  it('a refused envelope (stale epoch) fails every fill sent to that frame, with its reason', async () => {
    const { deps } = reportingDeps(() => ({ ok: false, error: 'stale_epoch' }))
    const out = await runScan(deps)
    expect(out.fill.filled).toEqual([])
    expect(out.fill.failed.map((f) => f.reason)).toEqual(['stale_epoch', 'stale_epoch'])
  })

  it('a frame that dies mid-fill fails its fills as frame-unreachable AND keeps the evidence report', async () => {
    const made = depsWithFields(twoAuto, 'auto')
    const inner = made.deps.sendToTab
    made.deps.sendToTab = vi.fn(async (frameId, message) => {
      if (message.type === 'JFF_FILL') throw new Error('frame vanished mid-fill')
      return inner(frameId, message)
    })
    const out = await runScan(made.deps)
    expect(out.fill.filled).toEqual([])
    expect(out.fill.failed.map((f) => f.reason)).toEqual(['frame-unreachable', 'frame-unreachable'])
    expect(out.frameReports.some((r) => r.error !== null && r.error.includes('fill failed'))).toBe(true)
  })

  it('a scan that never fills reports an EMPTY fill, not a lying one', async () => {
    const { deps } = depsWithFields([field(0, 0)], 'needs_input')
    const out = await runScan(deps)
    expect(out.fill).toEqual({ filled: [], failed: [] })
  })
})
