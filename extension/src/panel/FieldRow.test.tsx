import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { EnumField, Resolution } from '@jff/shared'
import { FieldRow } from './FieldRow'
import type { Row } from './group'

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
  onEdit: noop, onAccept: noop, onGenerate: noop, onFill: noop, onSaveFact: noop,
  generating: false, filled: false, acting: null, locked: false,
  // factsReady false by default, so only the tests that are about "Save to
  // profile" ever render the button.
  facts: {} as Record<string, string>, factsReady: false,
}

const needsInput = (label = 'Why us?') =>
  row(field({ label }), resolution({ tier: 'needs_input', value: null, source: null, key: null }))

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

  // A9: a ≤5-option select is no longer a textarea plus a comma-joined caption —
  // the same options are what the picker's datalist offers as typeahead.
  it('lists the available options for a select so the user can see what is valid', () => {
    render(<FieldRow {...props}
      row={row(field({ label: 'Work model', kind: 'select', options: ['Remote', 'Hybrid'] }), resolution({ tier: 'needs_input', value: null, source: null }))} />)
    const offered = Array.from(document.querySelectorAll<HTMLOptionElement>('datalist option')).map((o) => o.value)
    expect(offered).toEqual(['Remote', 'Hybrid'])
  })
})

const actingField = (fid: number): EnumField => ({
  frameId: 0, fid, epoch: 1, label: `Q${fid}`, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false,
})
const actingResolution = (fid: number, tier: 'proposed' | 'needs_input'): Resolution => ({
  handle: { frameId: 0, fid, epoch: 1 }, tier, value: 'stored answer', source: tier === 'proposed' ? 'llm_key' : null,
  key: null, answerId: null, reason: 'test',
})
const proposedRow: Row = { ref: '0:1', field: actingField(1), resolution: actingResolution(1, 'proposed') }
const needsInputRow: Row = { ref: '0:2', field: actingField(2), resolution: actingResolution(2, 'needs_input') }
// NOTE: reuse the module-scope `noop` the file already declares at line 16 —
// redeclaring it is a SyntaxError that kills the whole test module.

describe('FieldRow acting states', () => {
  it('shows Accepting… and disables the button while an accept is in flight', () => {
    // row fixture: tier 'proposed' with a value, as the file's existing proposed-row fixture builds it
    render(<FieldRow {...props} row={proposedRow} acting="accept" locked={true} />)
    const btn = screen.getByRole('button', { name: 'Accepting…' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('shows Filling… and disables Fill and Generate while a fill is in flight', () => {
    render(<FieldRow {...props} row={needsInputRow} edited="my answer" acting="fill" locked={true} />)
    expect((screen.getByRole('button', { name: 'Filling…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Generate with AI' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders idle labels when nothing is acting', () => {
    render(<FieldRow {...props} row={proposedRow} acting={null} />)
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(false)
  })

  // Page writes are serialized in App, so a row that is NOT the acting one still
  // cannot act. Leaving its buttons enabled makes the click a silent no-op.
  it('disables every action on a row while ANOTHER row is acting', () => {
    const { rerender } = render(<FieldRow {...props} row={proposedRow} acting={null} locked={true} />)
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true)

    rerender(<FieldRow {...props} row={needsInputRow} edited="my answer" acting={null} locked={true} />)
    expect((screen.getByRole('button', { name: 'Fill' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Generate with AI' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('FieldRow — kind-aware editors (A9)', () => {
  it('renders ≤5-option choice as segmented buttons and emits the pick as an edit', () => {
    const onEdit = vi.fn()
    const r = row(field({ kind: 'choice', options: ['Sim', 'Não'] }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} onEdit={onEdit} /></ul>)
    const seg = document.querySelector('[data-jff-editor="segmented"]')!
    const buttons = Array.from(seg.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).toEqual(['Sim', 'Não'])
    fireEvent.click(seg.querySelectorAll('button')[1]!)
    expect(onEdit).toHaveBeenCalledWith('0:1', 'Não')
  })

  it('marks the picked segment pressed', () => {
    const r = row(field({ kind: 'radiogroup', options: ['Yes', 'No'] }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} edited="No" /></ul>)
    const pressed = Array.from(document.querySelectorAll('[data-jff-editor="segmented"] button'))
      .map((b) => b.getAttribute('aria-pressed'))
    expect(pressed).toEqual(['false', 'true'])
  })

  it('marks the picked segment pressed under NORMALIZED comparison (B5d)', () => {
    // 'yes ' (trailing space, lower case) vs option 'Yes' — the fill engine
    // matches these normalized, so the highlight must too, or the user sees
    // "saved answer badge but nothing selected".
    const r = row(field({ kind: 'radiogroup', options: ['Yes', 'No'] }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} edited="yes " /></ul>)
    const pressed = Array.from(document.querySelectorAll('[data-jff-editor="segmented"] button'))
      .map((b) => b.getAttribute('aria-pressed'))
    expect(pressed).toEqual(['true', 'false'])
  })

  it('renders a >5-option set as a typeahead picker backed by a datalist', () => {
    const opts = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
    const r = row(field({ kind: 'select', options: opts }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    const input = document.querySelector<HTMLInputElement>('[data-jff-editor="picker"]')!
    expect(input.getAttribute('list')).toBe('opts-0:1')
    expect(document.querySelectorAll('datalist option')).toHaveLength(7)
  })

  it('renders harvested combobox options as a picker too', () => {
    const r = row(field({ kind: 'combobox', options: ['Brazil', 'Portugal'] }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(document.querySelector('[data-jff-editor="picker"]')).not.toBeNull()
  })

  it('annotates an empty-options combobox as a dropdown whose options load on fill', () => {
    const r = row(field({ kind: 'combobox', options: [] }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(document.querySelector('[data-jff-editor="combobox-empty"]')).not.toBeNull()
    expect(screen.getByText(/dropdown — options load on fill/)).toBeTruthy()
  })

  it('wires the resume-target file row to Put on page and never shows a textarea', () => {
    const onFillResume = vi.fn()
    const r = row(field({ kind: 'file', label: 'Resume', required: true }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} resumeTarget resumeName="cv.pdf" onFillResume={onFillResume} /></ul>)
    expect(screen.getByText(/cv\.pdf/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Put on page' }))
    expect(onFillResume).toHaveBeenCalledWith('0:1')
    expect(document.querySelector('textarea')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Generate with AI' })).toBeNull()
  })

  // The unlabelled, optional file input the ATS autofill pane ships: score 0,
  // so it can never be targeted and must not grow a second resume button.
  it('renders any other file row manual-only with its score reason', () => {
    const r = row(field({ kind: 'file', label: null, required: false }), resolution({ tier: 'needs_input', value: null, source: null }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(screen.getByText(/resume score 0/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Fill' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Put on page' })).toBeNull()
  })

  it('shows the description as a subtitle under the label', () => {
    const r = row(field({ description: 'Answer for your current country.' }), resolution())
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(document.querySelector('[data-jff-description]')!.textContent).toBe('Answer for your current country.')
  })

  it('shows the tier as a badge and stamps data-jff-tier on the row', () => {
    render(<ul><FieldRow row={needsInput()} {...props} /></ul>)
    const li = document.querySelector('li')!
    expect(li.getAttribute('data-jff-tier')).toBe('needs_input')
    expect(li.querySelector('[data-jff-tier-badge]')!.textContent).toBe('needs input')
  })
})

describe('FieldRow — foreign rows and hints (A9/B1 seam)', () => {
  const foreignRow = () => row(
    field({ frameId: 3, label: 'Newsletter email' }),
    resolution({ handle: { frameId: 3, fid: 1, epoch: 1 }, tier: 'needs_input', value: null, source: null, key: null, reason: 'other-frame' }),
  )

  it('foreign: frame badge, manual Fill only, no Generate', () => {
    render(<ul><FieldRow row={foreignRow()} {...props} edited="x" foreign /></ul>)
    expect(screen.getByText('frame 3')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Generate with AI' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Fill' })).toBeTruthy()
  })

  it('renders the human hint for a hinted reason', () => {
    const r = row(field(), resolution({ tier: 'needs_input', value: null, source: null, reason: 'choice-needs-user-click' }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(screen.getByText('Select this answer on the page yourself.')).toBeTruthy()
  })

  it('renders the combobox-no-listbox hint', () => {
    const r = row(field(), resolution({ tier: 'needs_input', value: null, source: null, reason: 'combobox-no-listbox' }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(screen.getByText('Open this dropdown on the page yourself and pick the value.')).toBeTruthy()
  })

  it('renders the no-matching-option hint', () => {
    const r = row(field(), resolution({ tier: 'needs_input', value: null, source: null, reason: 'no-matching-option' }))
    render(<ul><FieldRow row={r} {...props} /></ul>)
    expect(screen.getByText('No option matches this value. Try different text.')).toBeTruthy()
  })
})

describe('FieldRow — Save to profile (a fact is stored, never drafted)', () => {
  const keyed = (patch: Partial<Resolution> = {}) => row(
    field({ label: 'GitHub' }),
    resolution({ tier: 'needs_input', value: null, source: null, key: 'github', ...patch }),
  )
  const ready = { ...props, factsReady: true }
  const saveBtn = () => screen.queryByRole('button', { name: 'Save to profile' })
  const genBtn = () => screen.queryByRole('button', { name: 'Generate with AI' })

  it('offers Save to profile, not Generate, on a keyed needs-input row', () => {
    const onSaveFact = vi.fn()
    render(<ul><FieldRow {...ready} row={keyed()} edited="https://github.com/x" onSaveFact={onSaveFact} /></ul>)
    expect(genBtn()).toBeNull()
    fireEvent.click(saveBtn()!)
    expect(onSaveFact).toHaveBeenCalledWith('0:1')
  })

  it('offers it on a saved_answer row too, which had no controls at all before', () => {
    render(<ul><FieldRow {...ready} row={keyed({ tier: 'auto', value: 'https://github.com/x', source: 'saved_answer' })} /></ul>)
    expect(saveBtn()).toBeTruthy()
  })

  it('offers neither on a row already backed by the store', () => {
    render(<ul><FieldRow {...ready} row={keyed({ tier: 'auto', value: 'https://github.com/x', source: 'profile' })} /></ul>)
    expect(saveBtn()).toBeNull()
    expect(genBtn()).toBeNull()
  })

  it('offers neither when the key already holds a stored fact', () => {
    // The overwrite case: an ATS autofilled the page, and the stored value is
    // the good one. Changing it is the Profile editor's job.
    render(<ul><FieldRow
      {...ready} facts={{ github: 'https://github.com/kevinshibuya' }}
      row={keyed({ tier: 'auto', value: 'https://github.com/wrong', source: 'page' })}
    /></ul>)
    expect(saveBtn()).toBeNull()
    expect(genBtn()).toBeNull()
  })

  it('offers neither before the facts have arrived, even though facts is empty', () => {
    // Until the load lands every key looks absent. Offering the button here
    // would let one click overwrite a stored fact with a page value.
    render(<ul><FieldRow
      {...props} factsReady={false}
      row={keyed({ tier: 'auto', value: 'https://github.com/wrong', source: 'page' })}
    /></ul>)
    expect(saveBtn()).toBeNull()
  })

  it('disables it while the row has no value, while locked, and while acting', () => {
    const { rerender } = render(<ul><FieldRow {...ready} row={keyed()} /></ul>)
    expect((saveBtn() as HTMLButtonElement).disabled).toBe(true)
    rerender(<ul><FieldRow {...ready} row={keyed()} edited="https://github.com/x" locked /></ul>)
    expect((saveBtn() as HTMLButtonElement).disabled).toBe(true)
    rerender(<ul><FieldRow {...ready} row={keyed()} edited="https://github.com/x" acting="save_fact" /></ul>)
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy()
  })

  it('still offers Generate on a keyless needs-input row', () => {
    render(<ul><FieldRow {...ready} row={needsInput()} /></ul>)
    expect(genBtn()).toBeTruthy()
    expect(saveBtn()).toBeNull()
  })
})
