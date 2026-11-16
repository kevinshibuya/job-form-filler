import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, within } from '@testing-library/react'
import type { EnumField } from '@jff/shared'
import { App } from './App'
import { REASON_HINT } from './FieldRow'
import { OPTION_PICK_FAILED } from './optionPick'
import { field, installHeldMappingHost, mapped, release, resolution, rowOf, status, statusText, tierOf } from './testing/heldMapping'

/**
 * Ticket #34 at the panel seam (spec #6, testing decision 3): a row whose
 * stored Value is identified but has no rule answer takes part in the Fill
 * that follows a Scan. It is sent with no Value, so the page only reports the
 * Control's Options; then the model pick is asked with the identified Value,
 * and the row ends Proposed with the picked Option, or Needs input with the
 * picker. Nothing reaches the page until the user accepts.
 */

const EU = 'Are you authorized to work in the EU?'
const PRONOUNS = 'Pronouns'
const BEFORE = 'Have you previously worked for this company?'
const PROSE = 'I have spent the last six years building data pipelines for analytical engines, and I would bring that experience to your team from day one.'
const WORK_AUTH = 'Germany, Portugal'

const host = installHeldMappingHost()

const row = (label: string): HTMLElement => rowOf(label) as HTMLElement
const pickerOf = (label: string): HTMLInputElement | null => row(label).querySelector('[data-jff-editor="picker"]')
const pickerOptions = (label: string): string[] =>
  [...row(label).querySelectorAll('datalist option')].map((o) => o.getAttribute('value') ?? '')
const hintOf = (label: string): string | null => row(label).querySelector('[data-jff-hint]')?.textContent ?? null
const standsForOf = (label: string): string | null => row(label).querySelector('[data-jff-stands-for]')?.textContent ?? null
const ticked = (label: string): string[] =>
  [...row(label).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter((b) => b.checked).map((b) => b.value)
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

async function mountScanned(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe('done') })
}

describe('a work-authorization Field whose label names a region', () => {
  beforeEach(() => {
    host.nothingPending = true
    host.fields = [field(0, EU, { kind: 'combobox' })]
    host.firstNeedsInput = [0]
    host.firstPatch = { 0: { key: 'workAuth', reason: 'names-region', identifiedValue: WORK_AUTH } }
    host.offers = { 0: ['Yes, in every EU country', 'Only in some', 'No'] }
  })

  it('is read after the Scan, the pick is asked with the workAuth list, and the row ends Proposed with the picked Option', async () => {
    host.pick = () => ({ position: 0 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(EU)).toBe('proposed') })
    expect(host.reads).toEqual([0])
    expect(host.sent).toEqual([])
    expect(host.picks).toEqual([{ label: EU, value: WORK_AUTH, options: ['Yes, in every EU country', 'Only in some', 'No'] }])
    expect(pickerOf(EU)?.value).toBe('Yes, in every EU country')
    expect(standsForOf(EU)).toContain(WORK_AUTH)
    expect(host.page[0]).toBeUndefined()
    expect(statusText()).toContain('1 proposed, 0 need input')
  })

  it('accepting the pick commits that Option on the page', async () => {
    host.pick = () => ({ position: 2 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(EU)).toBe('proposed') })
    fireEvent.click(within(row(EU)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.page[0]).toBe('No') })
    expect(host.sent.at(-1)).toEqual({ fid: 0, value: 'No' })
    expect(host.picks).toHaveLength(1)
  })

  it('a pick of "none" leaves the row Needs input with the Options as a picker', async () => {
    await mountScanned()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    await settle()
    expect(tierOf(EU)).toBe('needs_input')
    expect(pickerOptions(EU)).toEqual(['Yes, in every EU country', 'Only in some', 'No'])
    expect(hintOf(EU)).toBe(REASON_HINT['names-region'])
    expect(standsForOf(EU)).toBeNull()
    expect(host.page[0]).toBeUndefined()
  })

  it('a pick that fails leaves the row Needs input with the picker and says so', async () => {
    host.pick = () => ({ error: { kind: 'timeout', message: 'codex timed out' } })
    await mountScanned()
    await waitFor(() => { expect(hintOf(EU)).toBe(REASON_HINT[OPTION_PICK_FAILED]) })
    expect(tierOf(EU)).toBe('needs_input')
    expect(pickerOptions(EU)).toEqual(['Yes, in every EU country', 'Only in some', 'No'])
  })

  it('a dropdown that read no Options stays Needs input and makes no model call', async () => {
    host.offers = {}
    await mountScanned()
    await waitFor(() => { expect(host.reads).toEqual([0]) })
    await settle()
    expect(host.picks).toEqual([])
    expect(tierOf(EU)).toBe('needs_input')
    expect(hintOf(EU)).toBe(REASON_HINT['names-region'])
  })

  it('with no workAuth list stored, the Field is not read and makes no model call', async () => {
    host.firstPatch = { 0: { key: 'workAuth', reason: 'names-region' } }
    await mountScanned()
    await settle()
    expect(host.reads).toEqual([])
    expect(host.fills).toEqual([])
    expect(host.picks).toEqual([])
    expect(tierOf(EU)).toBe('needs_input')
  })
})

describe('a pronoun checkbox group that offers no Option equal to the stored pronouns', () => {
  const group = (fields: EnumField[]) => fields.map((f) => resolution(f, {
    tier: 'needs_input', reason: 'custom', fieldClass: 'personal_fact', identifiedValue: 'she/her',
  }))

  beforeEach(() => {
    host.nothingPending = false
    host.fields = [field(0, PRONOUNS, { kind: 'checkboxgroup', options: ['He/him', 'They/them', 'Xe/xem'] })]
    host.mappingFor = group
    host.offers = { 0: ['He/him', 'They/them', 'Xe/xem'] }
  })

  it('ends Proposed with one picked Option, and nothing is ticked on the page until it is accepted', async () => {
    host.pick = () => ({ position: 1 })
    render(<App />)
    await waitFor(() => { expect(host.held).toHaveLength(1) })
    await release(host, (h) => mapped(host, h))
    await waitFor(() => { expect(tierOf(PRONOUNS)).toBe('proposed') })
    expect(host.reads).toEqual([0])
    expect(host.picks).toEqual([{ label: PRONOUNS, value: 'she/her', options: ['He/him', 'They/them', 'Xe/xem'] }])
    expect(ticked(PRONOUNS)).toHaveLength(1)
    expect(standsForOf(PRONOUNS)).toContain('she/her')
    expect(host.page[0]).toBeUndefined()

    fireEvent.click(within(row(PRONOUNS)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.page[0]).toBe('They/them') })
  })
})

describe('a native Yes/No select whose Saved answer is a paragraph', () => {
  beforeEach(() => {
    host.nothingPending = true
    host.fields = [field(0, BEFORE, { kind: 'select', options: ['Select...', 'Yes', 'No'] })]
    host.firstNeedsInput = [0]
    host.firstPatch = { 0: { reason: 'exact-match:no-offered-option', identifiedValue: PROSE } }
    host.offers = { 0: ['Select...', 'Yes', 'No'] }
  })

  it('ends Proposed with a picked Option, and the paragraph is never its Value', async () => {
    host.pick = () => ({ position: 2 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(BEFORE)).toBe('proposed') })
    expect(host.picks).toEqual([{ label: BEFORE, value: PROSE, options: ['Select...', 'Yes', 'No'] }])
    expect(pickerOf(BEFORE)?.value).toBe('No')
    expect(host.sent).toEqual([])
    expect(host.page[0]).toBeUndefined()
  })

  it('with none, ends Needs input with the picker, and the paragraph is never proposed', async () => {
    await mountScanned()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    await settle()
    expect(tierOf(BEFORE)).toBe('needs_input')
    expect(pickerOptions(BEFORE)).toEqual(['Select...', 'Yes', 'No'])
    expect(pickerOf(BEFORE)?.value).toBe('')
    expect(host.sent).toEqual([])
  })
})

describe('a row with no identified stored Value', () => {
  it('is not sent to Fill, and makes no model call', async () => {
    host.nothingPending = true
    host.fields = [field(0, 'How did you hear about us?', { kind: 'select', options: ['LinkedIn', 'A friend'] }), field(1, 'First name')]
    host.firstNeedsInput = [0]
    host.firstValues = { 1: 'Ada' }
    host.offers = { 0: ['LinkedIn', 'A friend'] }
    await mountScanned()
    await waitFor(() => { expect(host.page[1]).toBe('Ada') })
    await settle()
    expect(host.fills.flatMap((f) => f.fids)).toEqual([1])
    expect(host.reads).toEqual([])
    expect(host.picks).toEqual([])
  })
})
