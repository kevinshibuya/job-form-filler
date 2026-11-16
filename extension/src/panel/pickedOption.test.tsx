import { describe, it, expect, beforeEach } from 'vitest'
import { act, render, fireEvent, waitFor, within } from '@testing-library/react'
import type { EnumField } from '@jff/shared'
import { App } from './App'
import { NO_MATCH_PICK_HINT, REASON_HINT } from './FieldRow'
import { OPTION_PICK_FAILED } from './optionPick'
import { field, installHeldMappingHost, mapped, release, resolution, rowOf, status, statusText, tierOf } from './testing/heldMapping'

/**
 * Ticket #31 at the panel seam (spec #6, testing decision 3): when a Fill
 * misses on a Field whose stored Value is identified, the model may point at
 * one of the Options the Fill read (ADR 0008). The pick is Proposed, shows the
 * stored Value it stands for, and reaches the page only when accepted. The
 * fake page offers its Options only once a Fill opens the dropdown, as a
 * Greenhouse dropdown does.
 */

const COUNTRY = 'Country of residence'
const RELOCATE = 'Are you open to relocation?'
const PROSE = 'I have spent the last six years building data pipelines for analytical engines, and I would bring that experience to your team from day one.'

const host = installHeldMappingHost()
beforeEach(() => {
  host.nothingPending = true
})

const row = (label: string): HTMLElement => rowOf(label) as HTMLElement
const pickerOf = (label: string): HTMLInputElement | null => row(label).querySelector('[data-jff-editor="picker"]')
const pickerOptions = (label: string): string[] =>
  [...row(label).querySelectorAll('datalist option')].map((o) => o.getAttribute('value') ?? '')
const hintOf = (label: string): string | null => row(label).querySelector('[data-jff-hint]')?.textContent ?? null
const standsForOf = (label: string): string | null => row(label).querySelector('[data-jff-stands-for]')?.textContent ?? null

async function mountScanned(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe('done') })
}

describe('a country Value whose Fill missed on a Country dropdown', () => {
  beforeEach(() => {
    host.fields = [field(0, COUNTRY, { kind: 'combobox' })]
    host.firstValues = { 0: 'France' }
    host.firstCandidates = { 0: ['France', 'França'] }
    host.firstPatch = { 0: { key: 'country', source: 'profile', reason: 'recognizer:country' } }
    host.offers = { 0: ['French Republic', 'Kingdom of Spain', 'Italian Republic'] }
  })

  it('is handed to the pick with the label, the country as the stored Value and the Options the Fill read', async () => {
    await mountScanned()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    expect(host.picks[0]).toEqual({ label: COUNTRY, value: 'France', options: ['French Republic', 'Kingdom of Spain', 'Italian Republic'] })
  })

  it('a pick makes the row Proposed with the Option, shows the Value it stands for, and fills nothing', async () => {
    host.pick = () => ({ position: 0 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(COUNTRY)).toBe('proposed') })
    expect(pickerOf(COUNTRY)?.value).toBe('French Republic')
    expect(standsForOf(COUNTRY)).toContain('France')
    expect(host.page[0]).toBeUndefined()
    expect(host.fills).toHaveLength(1)
    expect(statusText()).toContain('1 proposed, 0 need input')
  })

  it('accepting the pick commits that Option on the page', async () => {
    host.pick = () => ({ position: 0 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(COUNTRY)).toBe('proposed') })
    fireEvent.click(within(row(COUNTRY)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.page[0]).toBe('French Republic') })
    expect(host.sent.at(-1)).toEqual({ fid: 0, value: 'French Republic' })
    await waitFor(() => { expect(tierOf(COUNTRY)).toBe('auto') })
    expect(host.picks).toHaveLength(1)
  })

  it('"none" makes the row Needs input with the Options as a picker', async () => {
    host.pick = () => ({ position: null })
    await mountScanned()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    expect(tierOf(COUNTRY)).toBe('needs_input')
    expect(hintOf(COUNTRY)).toBe(NO_MATCH_PICK_HINT)
    expect(pickerOptions(COUNTRY)).toEqual(['French Republic', 'Kingdom of Spain', 'Italian Republic'])
    expect(standsForOf(COUNTRY)).toBeNull()
    expect(host.page[0]).toBeUndefined()
  })

  it('a model call that fails leaves the row Needs input with the picker and says the pick failed', async () => {
    host.pick = () => ({ error: { kind: 'timeout', message: 'codex timed out' } })
    await mountScanned()
    await waitFor(() => { expect(within(row(COUNTRY)).getByText(OPTION_PICK_FAILED)).toBeTruthy() })
    expect(tierOf(COUNTRY)).toBe('needs_input')
    expect(hintOf(COUNTRY)).toBe(REASON_HINT[OPTION_PICK_FAILED])
    expect(hintOf(COUNTRY)).toMatch(/pick failed/i)
    expect(pickerOptions(COUNTRY)).toEqual(['French Republic', 'Kingdom of Spain', 'Italian Republic'])
    expect(host.page[0]).toBeUndefined()
  })

  it('a reply that is not a position counts as a failed pick, never as an Option', async () => {
    host.pick = () => ({ position: 'French Republic' } as unknown as { position: number })
    await mountScanned()
    await waitFor(() => { expect(tierOf(COUNTRY)).toBe('needs_input') })
    await waitFor(() => { expect(hintOf(COUNTRY)).toBe(REASON_HINT[OPTION_PICK_FAILED]) })
  })

  it('a position outside the Options is none', async () => {
    host.pick = () => ({ position: 3 })
    await mountScanned()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    expect(tierOf(COUNTRY)).toBe('needs_input')
    expect(hintOf(COUNTRY)).toBe(NO_MATCH_PICK_HINT)
  })

  it('an Option the user picked while the model ran is kept', async () => {
    let answer: (v: { position: number | null }) => void = () => {}
    host.pick = () => new Promise((resolve) => { answer = resolve })
    await mountScanned()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    fireEvent.change(pickerOf(COUNTRY)!, { target: { value: 'Italian Republic' } })
    await act(async () => {
      answer({ position: 0 })
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(tierOf(COUNTRY)).toBe('needs_input')
    expect(pickerOf(COUNTRY)?.value).toBe('Italian Republic')
  })
})

describe('a Saved answer whose Fill missed on a Yes/No dropdown', () => {
  beforeEach(() => {
    host.fields = [field(0, RELOCATE, { kind: 'combobox' })]
    host.firstValues = { 0: PROSE }
    host.firstPatch = { 0: { source: 'saved_answer', answerId: 4, reason: 'exact-match' } }
    host.offers = { 0: ['Yes', 'No'] }
  })

  it('is handed to the pick with its text as the Value, and the row ends Proposed with an Option', async () => {
    host.pick = () => ({ position: 0 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('proposed') })
    expect(host.picks[0]).toEqual({ label: RELOCATE, value: PROSE, options: ['Yes', 'No'] })
    expect(pickerOf(RELOCATE)?.value).toBe('Yes')
    expect(standsForOf(RELOCATE)).toContain(PROSE)
    expect(host.page[0]).toBeUndefined()
  })

  it('the prose is never proposed as the dropdown\'s Value: with none, the row is Needs input', async () => {
    await mountScanned()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    expect(tierOf(RELOCATE)).toBe('needs_input')
    expect(pickerOptions(RELOCATE)).toEqual(['Yes', 'No'])
    expect(row(RELOCATE).querySelector('[data-jff-tier="proposed"]')).toBeNull()
    expect(host.page[0]).toBeUndefined()
  })
})

describe('when no pick is made', () => {
  it('a Fill that misses with no identified stored Value makes no model call', async () => {
    host.fields = [field(0, RELOCATE, { kind: 'combobox' })]
    host.firstValues = { 0: 'Maybe' }
    host.offers = { 0: ['Yes', 'No'] }
    await mountScanned()
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('needs_input') })
    await new Promise((r) => setTimeout(r, 20))
    expect(host.picks).toEqual([])
  })

  it('a Fill the page refused for another reason than a missing match makes no model call', async () => {
    host.fields = [field(0, RELOCATE, { kind: 'combobox' })]
    host.firstValues = { 0: 'Yes' }
    host.firstPatch = { 0: { key: 'relocate', source: 'answer_bank', reason: 'recognizer:relocate' } }
    host.offers = { 0: ['Yes', 'No'] }
    host.refuse = { 0: 'no-commit' }
    await mountScanned()
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('needs_input') })
    await new Promise((r) => setTimeout(r, 20))
    expect(host.picks).toEqual([])
  })
})

describe('an Accept that misses', () => {
  const proposeYes = (fields: EnumField[]) => fields.map((f) => resolution(f, {
    tier: 'proposed', value: 'Yes', source: 'llm_key', key: 'relocate', reason: 'llm-key:relocate',
  }))

  it('is followed by the pick, and its Option is Proposed in turn', async () => {
    host.nothingPending = false
    host.fields = [field(0, RELOCATE, { kind: 'combobox' })]
    host.mappingFor = proposeYes
    host.offers = { 0: ['Yes, I would relocate', 'No, I would not'] }
    host.pick = () => ({ position: 0 })
    render(<App />)
    await waitFor(() => { expect(host.held).toHaveLength(1) })
    await release(host, (h) => mapped(host, h))
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('proposed') })

    fireEvent.click(within(row(RELOCATE)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    expect(host.picks[0]).toEqual({ label: RELOCATE, value: 'Yes', options: ['Yes, I would relocate', 'No, I would not'] })
    await waitFor(() => { expect(pickerOf(RELOCATE)?.value).toBe('Yes, I would relocate') })
    expect(tierOf(RELOCATE)).toBe('proposed')
    expect(standsForOf(RELOCATE)).toContain('Yes')
    expect(host.page[0]).toBeUndefined()

    fireEvent.click(within(row(RELOCATE)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.page[0]).toBe('Yes, I would relocate') })
    expect(host.picks).toHaveLength(1)
  })
})

// PR #36 manual pass 2: the post-Scan Fill was blocked by another open menu;
// the user's own Fill then missed, and no pick was ever asked.
describe('a manual Fill that misses on the row\'s own stored Value', () => {
  const SPONSOR = 'Will you now or in the future require sponsorship to work in the United States?'
  const WORDED = [
    'No – I am authorized and will not require sponsorship',
    'Yes – I am authorized now, but will require sponsorship in the future',
    'Yes – I am not currently authorized and will require sponsorship',
    'N/A – I am not located in the U.S.',
  ]
  beforeEach(() => {
    host.fields = [field(0, SPONSOR, { kind: 'combobox' })]
    host.firstValues = { 0: 'Yes' }
    host.firstPatch = { 0: { key: 'sponsorshipNeeded', source: 'answer_bank', reason: 'recognizer:sponsorshipNeeded' } }
    host.offers = { 0: WORDED }
    host.refuse = { 0: 'listbox-left-open' }
  })

  const fillAgain = async (): Promise<void> => {
    await waitFor(() => { expect(tierOf(SPONSOR)).toBe('needs_input') })
    expect(host.picks).toEqual([])
    host.refuse = {}
    fireEvent.click(within(row(SPONSOR)).getByRole('button', { name: 'Fill' }))
  }

  it('is handed to the pick, and a picked Option is Proposed with the Value it stands for, nothing on the page', async () => {
    host.pick = () => ({ position: 2 })
    await mountScanned()
    await fillAgain()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    expect(host.picks[0]).toEqual({ label: SPONSOR, value: 'Yes', options: WORDED })
    await waitFor(() => { expect(tierOf(SPONSOR)).toBe('proposed') })
    expect(standsForOf(SPONSOR)).toContain('Yes')
    expect(host.page[0]).toBeUndefined()
  })

  it('with no pick it stays Needs input with the Options, and a second Fill asks no second pick', async () => {
    await mountScanned()
    await fillAgain()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    expect(tierOf(SPONSOR)).toBe('needs_input')
    expect(pickerOptions(SPONSOR)).toEqual(WORDED)
    fireEvent.click(within(row(SPONSOR)).getByRole('button', { name: 'Fill' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(host.picks).toHaveLength(1)
  })
})
