import { describe, it, expect } from 'vitest'
import type { EnumField } from '@jff/shared'
import { elementByFid, enumerateFields } from './enumerate'
import { fillFields } from './fill'
import { loadRealFixture } from './fixtures/real'

// The content script over real-page fixtures: Enumeration finds the Field, Fill
// writes it, and the test reads both the Fill report and the page.

const ADA_LINKEDIN = 'https://www.linkedin.com/in/ada-lovelace'
const ADA_EMAIL = 'ada@example.com'

function scan(page: string): EnumField[] {
  loadRealFixture(page)
  return enumerateFields({ root: document, epoch: 1 }).fields
}

function find(fields: EnumField[], label: RegExp, kind?: string): EnumField {
  const hit = fields.find((f) => label.test(f.label ?? '') && (kind === undefined || f.kind === kind))
  if (hit === undefined) throw new Error(`no Field labelled ${label}; there are: ${fields.map((f) => `${f.kind}:${f.label}`).join(' | ')}`)
  return hit
}

function box(f: EnumField): HTMLInputElement {
  const el = elementByFid(document, f.fid)
  if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') throw new Error(`Field ${f.label} is not a checkbox`)
  return el
}

const handle = (f: EnumField) => ({ frameId: 0, fid: f.fid, epoch: f.epoch })
const fill = (f: EnumField, value: string) => fillFields(document, [{ handle: handle(f), value }])

describe('a checkbox Fill reports filled only when the box ends as asked', () => {
  it('a checkbox Fill asked to write a link fails and leaves the box unchanged', async () => {
    const linkedin = find(scan('lever-source-group'), /^LinkedIn$/)
    const report = await fill(linkedin, ADA_LINKEDIN)
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([{ handle: handle(linkedin), reason: 'value-not-yes-no' }])
    expect(box(linkedin).checked).toBe(false)
  })

  it('a checkbox Fill asked to write an email address fails and leaves the box unchanged', async () => {
    const marketing = find(scan('lever-marketing-consent'), /email/i, 'checkbox')
    const report = await fill(marketing, ADA_EMAIL)
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([{ handle: handle(marketing), reason: 'value-not-yes-no' }])
    expect(box(marketing).checked).toBe(false)
  })

  it('a ticked box asked to write a link fails too, and stays ticked', async () => {
    const marketing = find(scan('lever-marketing-consent'), /email/i, 'checkbox')
    box(marketing).checked = true
    const report = await fill(marketing, ADA_LINKEDIN)
    expect(report.failed.map((f) => f.handle)).toEqual([handle(marketing)])
    expect(box(marketing).checked).toBe(true)
  })

  it('a yes/no question about where the applicant is based refuses the location line', async () => {
    const based = find(scan('based-in-yes-no'), /based in US or Canada/i)
    const input = box(based)
    const report = await fill(based, 'London, UK')
    expect(report.filled).toEqual([])
    expect(report.failed.map((f) => f.handle)).toEqual([handle(based)])
    expect(input.checked).toBe(false)
  })

  it('a checkbox Fill asked for "true" ticks the box and reports it filled', async () => {
    const consent = find(scan('greenhouse-self-id'), /I consent/i, 'checkbox')
    const report = await fill(consent, 'true')
    expect(report.failed).toEqual([])
    expect(report.filled).toEqual([{ handle: handle(consent), committed: null }])
    expect(box(consent).checked).toBe(true)
  })

  it('a checkbox Fill asked for "no" unticks a ticked box and reports it filled', async () => {
    const consent = find(scan('greenhouse-self-id'), /I consent/i, 'checkbox')
    box(consent).checked = true
    const report = await fill(consent, 'no')
    expect(report.filled.map((f) => f.handle)).toEqual([handle(consent)])
    expect(box(consent).checked).toBe(false)
  })

  it('a box the page unticks right after the click is reported failed, not filled', async () => {
    const store = find(scan('lever-marketing-consent'), /armazenados/i, 'checkbox')
    const el = box(store)
    // A framework re-render that puts its own state back a moment after the click.
    el.addEventListener('click', () => { setTimeout(() => { el.checked = false }, 0) })
    const report = await fill(store, 'true')
    expect(report.filled).toEqual([])
    expect(report.failed.map((f) => f.handle)).toEqual([handle(store)])
    expect(el.checked).toBe(false)
  })

  it('a box whose click the page cancels is reported failed', async () => {
    const store = find(scan('lever-marketing-consent'), /armazenados/i, 'checkbox')
    const el = box(store)
    el.addEventListener('click', (e) => { e.preventDefault() })
    const report = await fill(store, 'true')
    expect(report.filled).toEqual([])
    expect(el.checked).toBe(false)
  })
})
