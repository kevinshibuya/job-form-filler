import { describe, expect, it, vi } from 'vitest'
import type { ContentMessage, EnumField } from '@jff/shared'
import type { HostPort } from './port'
import { resumeOnPage } from './resumeTarget'
import { runScan, type ScanDeps } from './scan'

// The Resume is uploaded once per page load (spec #41, ticket #49), at the
// seam of a Scan run with fake dependencies (testing decision 1). Each fake
// frame answers like the page script: it remembers a Resume it kept for as
// long as its document lives, and says so in its Scan reply.

const field = (fid: number, patch: Partial<EnumField> = {}): EnumField => ({
  frameId: -1, fid, epoch: 0, label: `L${fid}`, name: `n${fid}`, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

interface FakeFrame {
  url: string
  fields: EnumField[]
  /** The page script's memory: a Resume this document kept. */
  resumeUploaded: boolean
  /** Whether the page keeps an uploaded file. */
  keeps: boolean
  attachedUploads?: string[]
}

/** Frame 0 is the company's page with a newsletter box; frame 1 is the
 *  application form with a Resume file picker, and wins the election. */
function page(): FakeFrame[] {
  return [
    { url: 'https://careers.example/', fields: [field(0, { label: 'Newsletter email', name: 'email' })], resumeUploaded: false, keeps: true },
    {
      url: 'https://ats.example/apply',
      fields: [
        field(0, { label: 'First name', required: true }),
        field(1, { label: 'Why us?', required: true }),
        field(2, { label: 'Resume/CV', kind: 'file', idAttr: 'resume', accept: '.pdf', required: true }),
      ],
      resumeUploaded: false,
      keeps: true,
    },
  ]
}

/** A reload: every frame is a new document, with nothing remembered. */
function reload(frames: FakeFrame[]): void {
  for (const f of frames) f.resumeUploaded = false
}

function deps(frames: FakeFrame[]): { deps: ScanDeps; sent: ContentMessage[] } {
  const sent: ContentMessage[] = []
  let epoch = 0
  const d: ScanDeps = {
    nextEpoch: () => ++epoch,
    inject: vi.fn(async () => frames.map((_, i) => i)),
    sendToTab: vi.fn(async (frameId, message) => {
      sent.push(message)
      if (message.type === 'JFF_SCAN') {
        return {
          replies: frames.map((f, i) => ({
            frameId: i, url: f.url,
            payload: { ok: true, scan: {
              epoch: message.epoch, fields: f.fields, unreachableWidgets: 0, activeCaptcha: false,
              attachedUploads: f.attachedUploads ?? [], resumeUploaded: f.resumeUploaded,
            } },
          })),
          failures: [],
        }
      }
      if (message.type === 'JFF_FILL_RESUME') {
        const f = frames[frameId!]!
        if (f.keeps) f.resumeUploaded = true
        return { replies: [{ frameId: frameId!, payload: f.keeps ? { ok: true } : { ok: false, error: 'file-not-kept' } }], failures: [] }
      }
      if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
      if (message.type === 'JFF_FILL') return { replies: [{ frameId: frameId ?? 0, payload: { ok: true, fill: { epoch: message.epoch, filled: [], failed: [] } } }], failures: [] }
      return { replies: [{ frameId: 0, payload: { ok: false } }], failures: [] }
    }),
    onProgress: vi.fn(),
    sleep: vi.fn(async () => undefined),
    port: {
      request: vi.fn(async (method: string, params: unknown) => {
        if (method === 'selector.get') return { ok: true, result: { selector: null } }
        if (method === 'resolve.first') {
          const p = params as { epoch: number; fields: { frameId: number; fid: number }[] }
          return { ok: true, result: { epoch: p.epoch, pending: [], resolutions: p.fields.map((f) => ({
            handle: { frameId: f.frameId, fid: f.fid, epoch: p.epoch }, tier: 'needs_input', value: null,
            source: null, key: null, answerId: null, reason: 'test',
          })) } }
        }
        return { ok: true, result: {} }
      }),
      onDisconnect: () => undefined,
      disconnect: () => undefined,
    } as unknown as HostPort,
    getResume: async () => ({ name: 'ada-cv.pdf', mimeType: 'application/pdf', dataBase64: 'AAA=', text: null }),
    heldJobText: '',
  }
  return { deps: d, sent }
}

const uploads = (sent: ContentMessage[]): ContentMessage[] => sent.filter((m) => m.type === 'JFF_FILL_RESUME')

describe('a Scan uploads the Resume once per page load', () => {
  it('a first Scan on a page with a Resume file picker uploads it, exactly once', async () => {
    const { deps: d, sent } = deps(page())
    const out = await runScan(d)
    expect(out.election!.frameId).toBe(1)
    expect(uploads(sent)).toHaveLength(1)
    expect((uploads(sent)[0] as { handle: { frameId: number; fid: number } }).handle).toMatchObject({ frameId: 1, fid: 2 })
  })

  it('a second Scan on the same page sends no Resume upload, and reads as a Resume already on the page', async () => {
    const frames = page()
    await runScan(deps(frames).deps)
    const { deps: d, sent } = deps(frames)
    const out = await runScan(d)
    expect(uploads(sent)).toHaveLength(0)
    // No upload means no second read of the page either.
    expect(sent.filter((m) => m.type === 'JFF_SCAN')).toHaveLength(1)
    expect(out.resumeUploaded).toBe(true)
    expect(resumeOnPage(out.attachedUploads, out.resumeUploaded)).toBe(true)
  })

  it('after a reload, the next Scan uploads again', async () => {
    const frames = page()
    await runScan(deps(frames).deps)
    reload(frames)
    const { deps: d, sent } = deps(frames)
    await runScan(d)
    expect(uploads(sent)).toHaveLength(1)
  })

  it('after an upload the page refused, the next Scan uploads again', async () => {
    const frames = page()
    frames[1]!.keeps = false
    await runScan(deps(frames).deps)
    frames[1]!.keeps = true
    const { deps: d, sent } = deps(frames)
    await runScan(d)
    expect(uploads(sent)).toHaveLength(1)
  })

  it('the flag from a frame that was not elected does not stop the upload', async () => {
    const frames = page()
    frames[0]!.resumeUploaded = true
    const { deps: d, sent } = deps(frames)
    const out = await runScan(d)
    expect(out.election!.frameId).toBe(1)
    expect(uploads(sent)).toHaveLength(1)
  })

  it('a Resume the page shows attached still gets no upload, whatever the flag (#37)', async () => {
    const frames = page()
    frames[1]!.attachedUploads = ['Resume/CV']
    const { deps: d, sent } = deps(frames)
    const out = await runScan(d)
    expect(uploads(sent)).toHaveLength(0)
    expect(out.resumeUploaded).toBe(false)
    expect(resumeOnPage(out.attachedUploads, out.resumeUploaded)).toBe(true)
  })

  it('the cover-letter upload is never the target, before or after the Resume went up (#37)', async () => {
    const frames = page()
    frames[1]!.fields = [
      field(0, { label: 'First name', required: true }),
      field(1, { label: 'Cover Letter', kind: 'file', idAttr: 'cover_letter', accept: '.pdf' }),
      field(2, { label: 'Resume/CV', kind: 'file', idAttr: 'resume', accept: '.pdf', required: true }),
    ]
    const first = deps(frames)
    await runScan(first.deps)
    expect(uploads(first.sent).map((m) => (m as { handle: { fid: number } }).handle.fid)).toEqual([2])
    const second = deps(frames)
    await runScan(second.deps)
    expect(uploads(second.sent)).toHaveLength(0)
  })
})
