import { describe, it, expect, vi } from 'vitest'
import { GENERIC_MODULE, type AtsModule, type ContentMessage, type EnumField, type FieldHandle, type Resolution } from '@jff/shared'
import type { HostPort } from './port'
import { runMapping, runScan, type ScanDeps } from './scan'

/**
 * The ATS travels with the Scan (spec #41): the Side panel finds it from the
 * elected frame's address, falls back to the tab's hostname, sends it on both
 * Resolution requests, and asks the ATS's module which elected Fields to drop.
 * Every test runs the Scan against fake frames and a fake Native host.
 */

const field = (fid: number, label: string, patch: Partial<EnumField> = {}): EnumField => ({
  frameId: -1, fid, epoch: 0, label, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

interface Frame { frameId: number; url: string | null; fields: EnumField[] }

interface Setup {
  frames: Frame[]
  hostname?: string
  moduleFor?: ScanDeps['moduleFor']
  /** fids the first step leaves pending, so Mapping is owed. */
  pending?: number[]
}

function makeScan({ frames, hostname = '', moduleFor, pending = [] }: Setup) {
  let epoch = 0
  const resumeTo: FieldHandle[] = []
  const scans: number[] = []
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const sendToTab = vi.fn(async (_frameId: number | undefined, message: ContentMessage) => {
    if (message.type === 'JFF_SCAN') {
      scans.push(message.epoch)
      return {
        replies: frames.map((f) => ({
          frameId: f.frameId, url: f.url,
          payload: { ok: true, scan: { epoch: message.epoch, fields: f.fields, unreachableWidgets: 0, activeCaptcha: false } },
        })),
        failures: [],
      }
    }
    if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
    if (message.type === 'JFF_FILL_RESUME') { resumeTo.push(message.handle); return { replies: [{ frameId: message.handle.frameId, payload: { ok: true } }], failures: [] } }
    if (message.type === 'JFF_FILL') return { replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: message.epoch, filled: [], failed: [] } } }], failures: [] }
    return { replies: [], failures: [] }
  })
  const port = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      if (method === 'selector.get') return { ok: true, result: { selector: null } }
      const fields = (params.fields ?? []) as EnumField[]
      const handle = (f: EnumField) => ({ frameId: f.frameId, fid: f.fid, epoch: f.epoch })
      const res = (f: EnumField): Resolution => ({ handle: handle(f), tier: 'needs_input', value: null, source: null, key: null, answerId: null, reason: 'test' })
      if (method === 'resolve.first') {
        const left = fields.filter((f) => pending.includes(f.fid))
        return { ok: true, result: { epoch: params.epoch, resolutions: fields.filter((f) => !left.includes(f)).map(res), pending: left.map(handle) } }
      }
      if (method === 'resolve.mapping') return { ok: true, result: { epoch: params.epoch, resolutions: fields.map(res), llmError: null } }
      return { ok: true, result: {} }
    }),
    onDisconnect: () => undefined,
    disconnect: () => undefined,
  } as unknown as HostPort
  const deps: ScanDeps = {
    nextEpoch: () => ++epoch,
    inject: async () => frames.map((f) => f.frameId),
    sendToTab,
    onProgress: () => undefined,
    sleep: async () => undefined,
    port,
    getResume: async () => ({ name: 'cv.pdf', mimeType: 'application/pdf', dataBase64: 'AAA=' }),
    heldJobText: '',
    hostname,
    url: hostname === '' ? '' : `https://${hostname}/apply`,
    company: null,
    ...(moduleFor === undefined ? {} : { moduleFor }),
  }
  const sentWith = (method: string) => requests.filter((r) => r.method === method).map((r) => r.params)
  return { deps, resumeTo, scans, requests, sentWith }
}

/** A company's own page that holds an ATS's form in an iframe: the iframe wins the election. */
const embedded = (formUrl: string | null): Frame[] => [
  { frameId: 0, url: 'https://careers.example.com/jobs/1', fields: [field(0, 'Newsletter email')] },
  { frameId: 4, url: formUrl, fields: [field(0, 'First name', { required: true }), field(1, 'Why us?', { required: true, kind: 'textarea' })] },
]

describe('The ATS on a Scan', () => {
  it('sends the elected frame\'s ATS on both Resolution requests, whatever the tab\'s hostname is', async () => {
    const s = makeScan({ frames: embedded('https://jobs.lever.co/acme/123/apply'), hostname: 'boards.greenhouse.io', pending: [1] })
    const out = await runScan(s.deps)
    expect(out.election?.frameId).toBe(4)
    expect(out.ats).toBe('lever')
    await runMapping(s.deps, out, () => true)
    expect(s.sentWith('resolve.first')).toEqual([expect.objectContaining({ ats: 'lever' })])
    expect(s.sentWith('resolve.mapping')).toEqual([expect.objectContaining({ ats: 'lever' })])
  })

  it('falls back to the tab\'s hostname when the elected frame has no address', async () => {
    for (const url of [null, 'about:blank']) {
      const s = makeScan({ frames: embedded(url), hostname: 'jobs.ashbyhq.com', pending: [1] })
      const out = await runScan(s.deps)
      expect(out.election?.frameId).toBe(4)
      await runMapping(s.deps, out, () => true)
      expect(s.sentWith('resolve.first')).toEqual([expect.objectContaining({ ats: 'ashby' })])
      expect(s.sentWith('resolve.mapping')).toEqual([expect.objectContaining({ ats: 'ashby' })])
    }
  })

  it('sends generic on an unknown site', async () => {
    const s = makeScan({
      frames: [{ frameId: 0, url: 'https://careers.example.com/apply', fields: [field(0, 'Email'), field(1, 'Why us?')] }],
      hostname: 'careers.example.com', pending: [1],
    })
    const out = await runScan(s.deps)
    expect(out.ats).toBe('generic')
    await runMapping(s.deps, out, () => true)
    expect(s.sentWith('resolve.first')).toEqual([expect.objectContaining({ ats: 'generic' })])
    expect(s.sentWith('resolve.mapping')).toEqual([expect.objectContaining({ ats: 'generic' })])
  })

  it('a zero-Field Scan of a company page that holds an Ashby iframe is Ashby', async () => {
    const s = makeScan({
      frames: [
        { frameId: 0, url: 'https://careers.example.com/jobs/1', fields: [] },
        { frameId: 3, url: 'https://jobs.ashbyhq.com/acme/123', fields: [] },
      ],
      hostname: 'careers.example.com',
    })
    const out = await runScan(s.deps)
    expect(out.fields).toEqual([])
    expect(out.election).toBeNull()
    expect(out.ats).toBe('ashby')
    expect(s.requests).toEqual([])
  })

  it('a zero-Field Scan takes the tab\'s ATS before any frame\'s', async () => {
    const s = makeScan({
      frames: [
        { frameId: 0, url: 'https://jobs.lever.co/acme/123', fields: [] },
        { frameId: 3, url: 'https://jobs.ashbyhq.com/acme/123', fields: [] },
      ],
      hostname: 'jobs.lever.co',
    })
    expect((await runScan(s.deps)).ats).toBe('lever')
  })

  it('a zero-Field Scan with no known address is generic', async () => {
    const s = makeScan({ frames: [{ frameId: 0, url: 'https://careers.example.com/jobs/1', fields: [] }], hostname: 'careers.example.com' })
    expect((await runScan(s.deps)).ats).toBe('generic')
  })
})

describe('A module\'s junk rule on a Scan', () => {
  const JUNK = 'Autofill from resume'
  /** Ashby draws its form in an iframe. Its autofill upload outscores the real
   *  Resume upload, so only the junk rule keeps the Resume off it. */
  const frames: Frame[] = [
    { frameId: 0, url: 'https://careers.example.com/jobs/1', fields: [field(0, JUNK)] },
    {
      frameId: 2, url: 'https://jobs.ashbyhq.com/acme/123/application',
      fields: [
        field(0, 'First name', { required: true }),
        field(1, JUNK, { kind: 'file', required: true }),
        field(2, 'Resume', { kind: 'file' }),
      ],
    },
  ]
  const junkModule: AtsModule = { id: 'ashby', junkRule: (f) => f.label === JUNK }
  const moduleFor = vi.fn((ats: string): AtsModule => (ats === 'ashby' ? junkModule : GENERIC_MODULE))

  it('drops the Field it names from the elected frame, keeps it in another frame, and applies again after the Resume upload\'s second read', async () => {
    const s = makeScan({ frames, hostname: 'careers.example.com', moduleFor })
    const out = await runScan(s.deps)
    expect(moduleFor).toHaveBeenCalledWith('ashby')
    // First read: the Resume went to the real upload, not the dropped autofill one.
    expect(s.resumeTo).toEqual([expect.objectContaining({ frameId: 2, fid: 2 })])
    // The page was read a second time after the upload...
    expect(s.scans).toHaveLength(2)
    // ...and the rule ran on that read too: the host never sees the junk Field.
    const sent = s.sentWith('resolve.first')[0]!.fields as EnumField[]
    expect(sent.map((f) => [f.frameId, f.label])).toEqual([[2, 'First name'], [2, 'Resume']])
    // The same label in the frame that lost the election stays a row.
    expect(out.fields.map((f) => [f.frameId, f.label])).toEqual([[0, JUNK], [2, 'First name'], [2, 'Resume']])
  })

  it('the generic module drops nothing', async () => {
    const s = makeScan({ frames, hostname: 'careers.example.com' })
    const out = await runScan(s.deps)
    expect(s.resumeTo).toEqual([expect.objectContaining({ frameId: 2, fid: 1 })])
    expect(out.fields.filter((f) => f.label === JUNK)).toHaveLength(2)
  })

  it('sends no Resolution request when the rule drops every elected Field', async () => {
    const all: AtsModule = { id: 'ashby', junkRule: () => true }
    const s = makeScan({ frames, hostname: 'careers.example.com', moduleFor: (ats) => (ats === 'ashby' ? all : GENERIC_MODULE) })
    const out = await runScan(s.deps)
    expect(s.sentWith('resolve.first')).toEqual([])
    expect(out.fields.map((f) => [f.frameId, f.label])).toEqual([[0, JUNK]])
  })
})
