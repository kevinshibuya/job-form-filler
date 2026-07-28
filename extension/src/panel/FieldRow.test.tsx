import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { EnumField, Resolution } from '@jff/shared'
import { FieldRow } from './FieldRow'

const field = (patch: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid: 1, epoch: 1, label: 'Desired salary', name: null, idAttr: null,
  kind: 'text', options: [], required: true, visible: true, currentValue: null, demographic: false, ...patch,
})
const resolution = (patch: Partial<Resolution> = {}): Resolution => ({
  handle: { frameId: 0, fid: 1, epoch: 1 }, tier: 'auto', value: 'R$ 18.000/mo',
  source: 'answer_bank', key: 'salary', answerId: null, reason: 'recognizer:salary', ...patch,
})
const row = (f = field(), r = resolution()) => ({ ref: '0:1', field: f, resolution: r })

const noop = () => undefined

/** Default props, so a test only spells out what it is actually asserting on. */
const props = {
  edited: null as string | null,
  onEdit: noop, onAccept: noop, onGenerate: noop, onFill: noop,
  generating: false, filled: false,
}

const needsInput = (label = 'Why us?') =>
  row(field({ label }), resolution({ tier: 'needs_input', value: null, source: null }))

describe('FieldRow', () => {
  it('shows the label, the value and the source badge', () => {
    render(<FieldRow {...props} row={row()} />)
    expect(screen.getByText('Desired salary')).toBeTruthy()
    expect((screen.getByLabelText('Desired salary') as HTMLTextAreaElement).value).toBe('R$ 18.000/mo')
    expect(screen.getByText('saved fact')).toBeTruthy()
  })

  it('marks a required field', () => {
    render(<FieldRow {...props} row={row()} />)
    expect(screen.getByTitle('required')).toBeTruthy()
  })

  it('emits an edit as the user types', () => {
    const onEdit = vi.fn()
    render(<FieldRow {...props} row={row()} onEdit={onEdit} />)
    fireEvent.change(screen.getByLabelText('Desired salary'), { target: { value: 'R$ 20.000/mo' } })
    expect(onEdit).toHaveBeenCalledWith('0:1', 'R$ 20.000/mo')
  })

  it('prefers the local edit over the resolved value', () => {
    render(<FieldRow {...props} row={row()} edited="edited value" />)
    expect((screen.getByLabelText('Desired salary') as HTMLTextAreaElement).value).toBe('edited value')
  })

  it('shows Accept only for a proposed row', () => {
    const onAccept = vi.fn()
    const { rerender } = render(
      <FieldRow {...props} row={row(field(), resolution({ tier: 'proposed', source: 'llm_key' }))} onAccept={onAccept} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(onAccept).toHaveBeenCalledWith('0:1')

    rerender(<FieldRow {...props} row={row()} onAccept={onAccept} />)
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
  })

  it('shows Generate with AI only for a needs-input row', () => {
    const onGenerate = vi.fn()
    render(<FieldRow {...props} row={needsInput()} onGenerate={onGenerate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Generate with AI' }))
    expect(onGenerate).toHaveBeenCalledWith('0:1')
  })

  it('disables Generate and says so while a draft is running', () => {
    render(<FieldRow {...props} row={needsInput()} generating={true} />)
    const btn = screen.getByRole('button', { name: 'Drafting…' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  // The spec's loop is [Generate] -> draft -> user edits -> FILL. Without this
  // button the draft dies in the textarea and never reaches the page, because
  // Accept exists only on proposed rows and needs-input rows are never auto-filled.
  it('offers Fill on a needs-input row so an edited draft can reach the page', () => {
    const onFill = vi.fn()
    render(<FieldRow {...props} row={needsInput()} edited="my drafted answer" onFill={onFill} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }))
    expect(onFill).toHaveBeenCalledWith('0:1')
  })

  it('disables Fill while the needs-input row is still empty', () => {
    render(<FieldRow {...props} row={needsInput()} />)
    expect((screen.getByRole('button', { name: 'Fill' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('confirms on the row once its value has been put on the page', () => {
    render(<FieldRow {...props} row={needsInput()} edited="my drafted answer" filled={true} />)
    expect(screen.getByText('on the page')).toBeTruthy()
  })

  it('offers no Fill button on a proposed row, where Accept already fills', () => {
    render(<FieldRow {...props} row={row(field(), resolution({ tier: 'proposed', source: 'llm_key' }))} />)
    expect(screen.queryByRole('button', { name: 'Fill' })).toBeNull()
  })

  it('renders a skipped EEO row read-only with an explanation and no value', () => {
    render(<FieldRow {...props}
      row={row(field({ label: 'Gender', demographic: true }), resolution({ tier: 'skipped', value: null, source: null, reason: 'eeo' }))} />)
    expect(screen.getByText('Demographic question. Never auto-filled.')).toBeTruthy()
    expect(screen.queryByLabelText('Gender')).toBeNull()
  })

  it('lists the available options for a select so the user can see what is valid', () => {
    render(<FieldRow {...props}
      row={row(field({ label: 'Work model', kind: 'select', options: ['Remote', 'Hybrid'] }), resolution({ tier: 'needs_input', value: null, source: null }))} />)
    expect(screen.getByText('Remote, Hybrid')).toBeTruthy()
  })
})
