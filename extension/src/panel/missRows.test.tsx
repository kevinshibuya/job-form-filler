import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { EnumField } from '@jff/shared'
import { App } from './App'
import { NO_MATCH_PICK_HINT, REASON_HINT } from './FieldRow'
import { field, installHeldMappingHost, mapped, release, resolution, rowOf, status, tierOf } from './testing/heldMapping'

/**
 * Ticket #28 at the panel seam (spec #6, testing decision 3): a Fill that finds
 * no matching Option never leaves its row as it was. The row becomes Needs
 * input with the reason and offers the Options the Fill read as a picker, and
 * an Accept that cannot be filled says so on the row itself. The fake page
 * offers its Options only once a Fill opens the dropdown, as a Greenhouse
 * dropdown does; what is asserted is what the user sees and what the page holds.
 */

const RELOCATE = 'Are you open to relocation?'
const PROSE = 'I have spent the last six years building data pipelines for analytical engines, and I would bring that experience to your team from day one.'

const host = installHeldMappingHost()
beforeEach(() => {
  host.nothingPending = true
})

const row = (label: string): HTMLElement => rowOf(label) as HTMLElement
const pickerOptions = (label: string): string[] =>
  [...row(label).querySelectorAll('datalist option')].map((o) => o.getAttribute('value') ?? '')
const hintOf = (label: string): string | null => row(label).querySelector('[data-jff-hint]')?.textContent ?? null

async function mountScanned(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe('done') })
}

describe('a Fill that misses after a Scan', () => {
  beforeEach(() => {
    host.fields = [field(0, RELOCATE, { kind: 'combobox' })]
    host.firstValues = { 0: 'Maybe' }
    host.offers = { 0: ['Yes', 'No'] }
  })

  it('the row is Needs input, shows the reason and offers "Yes" and "No" as a picker', async () => {
    await mountScanned()
    expect(tierOf(RELOCATE)).toBe('needs_input')
    expect(hintOf(RELOCATE)).toBe(NO_MATCH_PICK_HINT)
    expect(within(row(RELOCATE)).getByText('no-matching-option')).toBeTruthy()
    expect(pickerOptions(RELOCATE)).toEqual(['Yes', 'No'])
    expect(host.page[0]).toBeUndefined()
  })

  it('picking "No" in that picker and filling commits "No" on the page', async () => {
    await mountScanned()
    fireEvent.change(screen.getByLabelText(RELOCATE), { target: { value: 'No' } })
    fireEvent.click(within(row(RELOCATE)).getByRole('button', { name: 'Fill' }))
    expect(await within(row(RELOCATE)).findByText('on the page')).toBeTruthy()
    expect(host.sent.at(-1)).toEqual({ fid: 0, value: 'No' })
    expect(host.page[0]).toBe('No')
  })

  it('a Saved answer of prose on a dropdown whose Options were not known at Scan ends as Needs input with the picker, and the page holds nothing', async () => {
    host.firstValues = { 0: PROSE }
    await mountScanned()
    expect(tierOf(RELOCATE)).toBe('needs_input')
    expect(pickerOptions(RELOCATE)).toEqual(['Yes', 'No'])
    expect(host.page[0]).toBeUndefined()
  })
})

describe('Accept never fails in silence', () => {
  const proposeMaybe = (fields: EnumField[]) => fields.map((f) => resolution(f, {
    tier: 'proposed', value: 'Maybe', source: 'llm_key', key: 'relocate', reason: 'llm-key:relocate',
  }))

  beforeEach(() => {
    host.nothingPending = false
    host.fields = [field(0, RELOCATE, { kind: 'combobox' })]
    host.mappingFor = proposeMaybe
    host.offers = { 0: ['Yes', 'No'] }
  })

  it('accepting a Proposed row whose Value matches no Option leaves a message on the row, and the row offers the picker', async () => {
    render(<App />)
    await waitFor(() => { expect(host.held).toHaveLength(1) })
    await release(host, (h) => mapped(host, h))
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('proposed') })
    expect(pickerOptions(RELOCATE)).toEqual([])

    fireEvent.click(within(row(RELOCATE)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('needs_input') })
    expect(hintOf(RELOCATE)).toBe(NO_MATCH_PICK_HINT)
    expect(pickerOptions(RELOCATE)).toEqual(['Yes', 'No'])
    expect(host.page[0]).toBeUndefined()
  })
})

describe('the reasons a verified commit fails with', () => {
  beforeEach(() => {
    host.fields = [field(0, RELOCATE, { kind: 'combobox' })]
    host.firstValues = { 0: 'Yes' }
  })

  it.each(['no-commit', 'listbox-left-open'])('a Fill that fails as %s shows that reason\'s wording on the row', async (reason) => {
    host.refuse = { 0: reason }
    await mountScanned()
    expect(tierOf(RELOCATE)).toBe('needs_input')
    expect(REASON_HINT[reason]).toBeDefined()
    expect(hintOf(RELOCATE)).toBe(REASON_HINT[reason])
  })
})

describe('where a picker is offered', () => {
  it('a dropdown that was never opened shows no picker and says its Options load on Fill', async () => {
    host.fields = [field(0, RELOCATE, { kind: 'combobox' })]
    host.firstNeedsInput = [0]
    await mountScanned()
    expect(row(RELOCATE).querySelector('datalist')).toBeNull()
    expect(within(row(RELOCATE)).getByText(/options load on fill/i)).toBeTruthy()
  })

  it('a radio group, a checkbox group and a native select still offer their pickers after a Scan', async () => {
    host.fields = [
      field(0, 'Willing to travel?', { kind: 'radiogroup', options: ['Yes', 'No'] }),
      field(1, 'Which languages do you speak?', { kind: 'checkboxgroup', options: ['English', 'French', 'German'] }),
      field(2, 'Highest degree', { kind: 'select', options: ['Select...', 'Bachelor', 'Master', 'Doctorate'] }),
    ]
    host.firstNeedsInput = [0, 1, 2]
    await mountScanned()
    expect(within(row('Willing to travel?')).getAllByRole('button', { pressed: false }).map((b) => b.textContent)).toEqual(['Yes', 'No'])
    expect(row('Which languages do you speak?').querySelectorAll('[data-jff-editor="checkboxes"] input[type="checkbox"]')).toHaveLength(3)
    expect(pickerOptions('Highest degree')).toEqual(['Select...', 'Bachelor', 'Master', 'Doctorate'])
  })
})
