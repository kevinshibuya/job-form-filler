import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { EnumField, Resolution } from '@jff/shared'
import { FieldRow } from './FieldRow'

const noop = () => undefined

function skippedRow(required: boolean) {
  const field: EnumField = {
    frameId: 0, fid: 1, epoch: 1, label: 'What is your gender?', name: null, idAttr: null,
    kind: 'select', options: ['Woman', 'Man', 'Prefer not to say'], required, visible: true, currentValue: null, demographic: true,
  }
  const resolution: Resolution = {
    handle: { frameId: 0, fid: 1, epoch: 1 }, tier: 'skipped', value: null,
    source: null, key: null, answerId: null, reason: 'eeo',
  }
  return { ref: '0:1', field, resolution }
}

function renderSkipped(required: boolean) {
  render(<FieldRow
    row={skippedRow(required)} edited={null}
    onEdit={noop} onAccept={noop} onGenerate={noop} onFill={noop} onSaveFact={noop}
    generating={false} filled={false} acting={null} locked={false}
    facts={{}} factsReady={false}
  />)
}

describe('a Skipped row in the Side panel', () => {
  it('shows the required mark when its Field is required', () => {
    renderSkipped(true)
    expect(screen.getByTitle('required').textContent).toBe('*')
  })

  it('shows no required mark when its Field is optional', () => {
    renderSkipped(false)
    expect(screen.queryByTitle('required')).toBeNull()
  })

  it('offers no Generation and no value, required or not', () => {
    renderSkipped(true)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
