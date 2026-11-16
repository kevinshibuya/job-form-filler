import { describe, it, expect, vi } from 'vitest'
import type { ContentMessage, EnumField, FieldHandle, Resolution } from '@jff/shared'
import { enumerateFields, type MeasureFn } from '../content/enumerate'
import { loadRealFixture } from '../content/fixtures/real'
import type { HostPort } from './port'
import { dropJunk } from './junk'
import { runScan, type ScanDeps } from './scan'

/**
 * A page that is not a form (#53). After the junk filter, a Scan that keeps
 * exactly one Field treats the page as having none when that Field is a
 * dropdown that already holds a Value and sits outside any form: a listing
 * page's language dropdown is not an application. Such a Scan asks the Native
 * host nothing and its outcome has no Fields, so the Side panel shows the empty
 * state. Nothing wider: every other page is still a form. Every test runs the
 * Scan against fake frames and a fake Native host.
 */

const field = (fid: number, label: string, patch: Partial<EnumField> = {}): EnumField => ({
  frameId: -1, fid, epoch: 0, label, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

const languageDropdown = (patch: Partial<EnumField> = {}): EnumField =>
  field(0, 'Language', { kind: 'select', options: ['English', 'Deutsch', 'Français'], currentValue: 'English', inForm: false, ...patch })

function makeScan(fields: EnumField[], hostname = 'careers.acme.example') {
  let epoch = 0
  const resumeTo: FieldHandle[] = []
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const sendToTab = vi.fn(async (_frameId: number | undefined, message: ContentMessage) => {
    if (message.type === 'JFF_SCAN') {
      return {
        replies: [{ frameId: 0, url: `https://${hostname}/jobs`, payload: { ok: true, scan: { epoch: message.epoch, fields, unreachableWidgets: 0, activeCaptcha: false } } }],
        failures: [],
      }
    }
    if (message.type === 'JFF_JOBTEXT') return { replies: [{ frameId: 0, payload: { ok: true, jobText: { text: '', selector: null, source: 'none' } } }], failures: [] }
    if (message.type === 'JFF_FILL_RESUME') { resumeTo.push(message.handle); return { replies: [{ frameId: 0, payload: { ok: true } }], failures: [] } }
    if (message.type === 'JFF_FILL') return { replies: [{ frameId: 0, payload: { ok: true, fill: { epoch: message.epoch, filled: [], failed: [] } } }], failures: [] }
    return { replies: [], failures: [] }
  })
  const port = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      if (method === 'selector.get') return { ok: true, result: { selector: null } }
      const sent = (params.fields ?? []) as EnumField[]
      const res = (f: EnumField): Resolution => ({ handle: { frameId: f.frameId, fid: f.fid, epoch: f.epoch }, tier: 'needs_input', value: null, source: null, key: null, answerId: null, reason: 'test' })
      if (method === 'resolve.first') return { ok: true, result: { epoch: params.epoch, resolutions: sent.map(res), pending: [] } }
      return { ok: true, result: {} }
    }),
    onDisconnect: () => undefined,
    disconnect: () => undefined,
  } as unknown as HostPort
  const deps: ScanDeps = {
    nextEpoch: () => ++epoch,
    inject: async () => [0],
    sendToTab,
    onProgress: () => undefined,
    sleep: async () => undefined,
    port,
    getResume: async () => ({ name: 'cv.pdf', mimeType: 'application/pdf', dataBase64: 'AAA=' }),
    heldJobText: '',
    hostname,
    url: `https://${hostname}/jobs`,
    company: null,
  }
  const resolvedLabels = () => requests
    .filter((r) => r.method === 'resolve.first')
    .flatMap((r) => (r.params.fields as EnumField[]).map((f) => f.label))
  return { deps, requests, resumeTo, resolvedLabels }
}

describe('a lone dropdown outside a form is not a form', () => {
  it('a Scan of the listing fixture sends no request to the Native host and its outcome has no Fields', async () => {
    loadRealFixture('listing-language-dropdown')
    const visible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })
    const { fields } = enumerateFields({ root: document, epoch: 1, measure: visible })
    // The junk filter keeps the dropdown, so the rule, not the filter, empties the Scan.
    expect(dropJunk(fields)).toHaveLength(1)
    const { deps, requests, resumeTo } = makeScan(fields)
    const out = await runScan(deps)
    expect(requests).toEqual([])
    expect(resumeTo).toEqual([])
    expect(out.fields).toEqual([])
    expect(out.resolutions).toEqual([])
    expect(out.pending).toEqual([])
  })

  it('one dropdown outside a form that holds a Value: no Resolution request, no Fields', async () => {
    const { deps, requests } = makeScan([languageDropdown()])
    const out = await runScan(deps)
    expect(requests).toEqual([])
    expect(out.fields).toEqual([])
    expect(out.resolutions).toEqual([])
  })

  it('a type-to-search dropdown is a dropdown too', async () => {
    const { deps, requests } = makeScan([languageDropdown({ kind: 'combobox', options: [] })])
    const out = await runScan(deps)
    expect(requests).toEqual([])
    expect(out.fields).toEqual([])
  })

  it('counts the Fields the junk filter keeps: a hidden text box beside the dropdown does not make a form', async () => {
    const hiddenSearch = field(1, null as unknown as string, { label: null, visible: false, inForm: false })
    const { deps, requests } = makeScan([languageDropdown(), hiddenSearch])
    const out = await runScan(deps)
    expect(requests).toEqual([])
    expect(out.fields).toEqual([])
  })

  it('on an ATS posting the empty state keeps the ATS, so it shows the ATS\'s hint', async () => {
    const { deps, requests } = makeScan([languageDropdown()], 'jobs.lever.co')
    const out = await runScan(deps)
    expect(requests).toEqual([])
    expect(out.fields).toEqual([])
    expect(out.ats).toBe('lever')
  })
})

describe('every other page is still a form', () => {
  it('a Field with no flag, from a page script loaded before #53, is read as inside a form', async () => {
    const { inForm: _, ...unflagged } = languageDropdown()
    const { deps, resolvedLabels } = makeScan([unflagged])
    const out = await runScan(deps)
    expect(resolvedLabels()).toEqual(['Language'])
    expect(out.fields).toHaveLength(1)
  })

  it('one dropdown inside a form', async () => {
    const { deps, resolvedLabels } = makeScan([languageDropdown({ label: 'Country', inForm: true })])
    const out = await runScan(deps)
    expect(resolvedLabels()).toEqual(['Country'])
    expect(out.fields).toHaveLength(1)
  })

  it('one dropdown outside a form that holds no Value', async () => {
    const { deps, resolvedLabels } = makeScan([languageDropdown({ label: 'Country', currentValue: null })])
    const out = await runScan(deps)
    expect(resolvedLabels()).toEqual(['Country'])
    expect(out.fields).toHaveLength(1)
  })

  it('one text box outside a form, even one that holds a Value', async () => {
    const { deps, resolvedLabels } = makeScan([field(0, 'Email', { currentValue: 'ada@example.com', inForm: false })])
    const out = await runScan(deps)
    expect(resolvedLabels()).toEqual(['Email'])
    expect(out.fields).toHaveLength(1)
  })

  it('two dropdowns outside a form', async () => {
    const { deps, resolvedLabels } = makeScan([
      languageDropdown(),
      field(1, 'Country', { kind: 'select', options: ['Canada', 'United States'], currentValue: 'Canada', inForm: false }),
    ])
    const out = await runScan(deps)
    expect(resolvedLabels()).toEqual(['Language', 'Country'])
    expect(out.fields).toHaveLength(2)
  })

  it('a wizard step that holds only radio groups and dropdowns, outside a form', async () => {
    const { deps, resolvedLabels } = makeScan([
      field(0, 'Are you authorized to work in the United States?', { kind: 'radiogroup', options: ['Yes', 'No'], currentValue: 'Yes', inForm: false }),
      field(1, 'Years of experience', { kind: 'select', options: ['0-2', '3-5', '6+'], currentValue: '3-5', inForm: false }),
      field(2, 'Willing to relocate?', { kind: 'choice', options: ['Yes', 'No'], inForm: false }),
    ])
    const out = await runScan(deps)
    expect(resolvedLabels()).toEqual(['Are you authorized to work in the United States?', 'Years of experience', 'Willing to relocate?'])
    expect(out.fields).toHaveLength(3)
  })

  it('a wizard step that holds one radio group alone, outside a form', async () => {
    const { deps, resolvedLabels } = makeScan([
      field(0, 'Do you need sponsorship?', { kind: 'radiogroup', options: ['Yes', 'No'], currentValue: 'No', inForm: false }),
    ])
    const out = await runScan(deps)
    expect(resolvedLabels()).toEqual(['Do you need sponsorship?'])
    expect(out.fields).toHaveLength(1)
  })
})
