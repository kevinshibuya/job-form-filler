import { describe, it, expect } from 'vitest'
import { render, within } from '@testing-library/react'
import { optionSetValue, type EnumField, type Resolution } from '@jff/shared'
import { FieldRow, type FieldRowProps } from './FieldRow'

// A checkbox group a Saved answer only partly matches comes back Proposed with
// the matching Options as its Value. The row shows those Options ticked, so the
// user confirms the partial answer before it reaches the page.

const group: EnumField = {
  frameId: 0, fid: 7, epoch: 2, label: 'How did you hear about us?', name: 'source', idAttr: null,
  kind: 'checkboxgroup', options: ['LinkedIn', 'Indeed', 'Employee Referral', 'Other'],
  required: false, visible: true, currentValue: null, demographic: false,
}

const proposed = (value: string): Resolution => ({
  handle: { frameId: 0, fid: 7, epoch: 2 }, tier: 'proposed', value,
  source: 'saved_answer', key: null, answerId: 3, reason: 'exact-match:partial',
})

const noop = () => undefined
const base: Omit<FieldRowProps, 'row'> = {
  edited: null, onEdit: noop, onAccept: noop, onGenerate: noop, onFill: noop, onSaveFact: noop,
  generating: false, filled: false, acting: null, locked: false, facts: {}, factsReady: false,
}

function ticked(value: string): Record<string, boolean> {
  const { container } = render(<ul><FieldRow {...base} row={{ ref: '0:7', field: group, resolution: proposed(value) }} /></ul>)
  const row = within(container).getByRole('group', { name: 'How did you hear about us?' })
  return Object.fromEntries(group.options.map((o) => [o, (within(row).getByRole('checkbox', { name: o }) as HTMLInputElement).checked]))
}

describe('a Proposed checkbox group row', () => {
  it('shows the matching Options ticked and the others clear', () => {
    expect(ticked(optionSetValue(['LinkedIn', 'Employee Referral']))).toEqual({
      LinkedIn: true, Indeed: false, 'Employee Referral': true, Other: false,
    })
  })

  it('offers Accept, so the user confirms the partial answer', () => {
    const { container } = render(<ul><FieldRow {...base} row={{ ref: '0:7', field: group, resolution: proposed('LinkedIn') }} /></ul>)
    const row = within(container).getByRole('listitem')
    expect(row.getAttribute('data-jff-tier')).toBe('proposed')
    expect(within(row).getByRole('button', { name: 'Accept' })).toBeTruthy()
  })
})
