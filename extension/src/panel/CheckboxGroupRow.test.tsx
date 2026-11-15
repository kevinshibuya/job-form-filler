import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, fireEvent, within, waitFor } from '@testing-library/react'
import type { EnumField, Resolution } from '@jff/shared'
import { FieldRow, type FieldRowProps } from './FieldRow'
import { dropJunk } from './junk'
import { enumerateFields, type MeasureFn } from '../content/enumerate'
import { fillFields } from '../content/fill'
import { isDemographic } from '../content/classify'
import { loadRealFixture } from '../content/fixtures/real'

// The content script scans a real-page fixture, and the Side panel renders the
// row the scan yields: what the row shows, and what pressing Fill leaves on the page.

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })

function scan(page: string): EnumField[] {
  loadRealFixture(page)
  return enumerateFields({
    root: document, epoch: 1, measure: allVisible,
    isDemographic: (el) => isDemographic(el, { isSubframe: false }),
  }).fields.map((f) => ({ ...f, frameId: 0 }))
}

function only(fields: EnumField[], label: RegExp): EnumField {
  const hits = fields.filter((f) => label.test(f.label ?? ''))
  if (hits.length !== 1) throw new Error(`${hits.length} Fields labelled ${label}`)
  return hits[0]!
}

const needsInput = (f: EnumField, patch: Partial<Resolution> = {}): Resolution => ({
  handle: { frameId: f.frameId, fid: f.fid, epoch: f.epoch }, tier: 'needs_input', value: null,
  source: null, key: null, answerId: null, reason: 'custom', ...patch,
})

const noop = () => undefined
const base: Omit<FieldRowProps, 'row'> = {
  edited: null, onEdit: noop, onAccept: noop, onGenerate: noop, onFill: noop, onSaveFact: noop,
  generating: false, filled: false, acting: null, locked: false, facts: {}, factsReady: false,
}

/** A row the way the panel holds it: the user's edit is kept and Fill reads it. */
function Panel(p: { field: EnumField; resolution: Resolution; onFill: (value: string) => void }) {
  const [edited, setEdited] = useState<string | null>(null)
  return (
    <ul>
      <FieldRow
        {...base} row={{ ref: '0:' + p.field.fid, field: p.field, resolution: p.resolution }}
        edited={edited} onEdit={(_, v) => setEdited(v)}
        onFill={() => p.onFill(edited ?? p.resolution.value ?? '')}
      />
    </ul>
  )
}

function pageBox(text: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll('form label')).find((l) => (l.textContent ?? '').trim() === text)
  const box = label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null
  if (box === null) throw new Error(`no box labelled ${text} on the page`)
  return box
}

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('the Side panel shows a checkbox group as one row', () => {
  it('the group row shows the question and one tick box per Option, and no text area', () => {
    const pronouns = only(scan('lever-pronoun-group'), /^pronouns$/i)
    const view = within(render(<Panel field={pronouns} resolution={needsInput(pronouns)} onFill={noop} />).container)
    const row = view.getByRole('group', { name: 'Pronouns' })
    const ticks = within(row).getAllByRole('checkbox')
    expect(ticks.map((t) => t.getAttribute('aria-label') ?? t.closest('label')?.textContent?.trim())).toEqual(pronouns.options)
    expect(view.queryByRole('textbox')).toBeNull()
  })

  it('ticking Options in the row sends the set as labels in page order, one per line', () => {
    const pronouns = only(scan('lever-pronoun-group'), /^pronouns$/i)
    const onEdit = vi.fn()
    const { rerender, container } = render(<ul><FieldRow {...base} row={{ ref: '0:2', field: pronouns, resolution: needsInput(pronouns) }} onEdit={onEdit} /></ul>)
    fireEvent.click(within(container).getByRole('checkbox', { name: 'They/them' }))
    expect(onEdit).toHaveBeenLastCalledWith('0:2', 'They/them')

    rerender(<ul><FieldRow {...base} row={{ ref: '0:2', field: pronouns, resolution: needsInput(pronouns) }} onEdit={onEdit} edited="They/them" /></ul>)
    fireEvent.click(within(container).getByRole('checkbox', { name: 'He/him' }))
    expect(onEdit).toHaveBeenLastCalledWith('0:2', 'He/him\nThey/them')

    rerender(<ul><FieldRow {...base} row={{ ref: '0:2', field: pronouns, resolution: needsInput(pronouns) }} onEdit={onEdit} edited={'He/him\nThey/them'} /></ul>)
    expect((within(container).getByRole('checkbox', { name: 'He/him' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(container).getByRole('checkbox', { name: 'They/them' }))
    expect(onEdit).toHaveBeenLastCalledWith('0:2', 'He/him')
  })

  it('a group row offers no Generate with AI', () => {
    const pronouns = only(scan('lever-pronoun-group'), /^pronouns$/i)
    const view = within(render(<Panel field={pronouns} resolution={needsInput(pronouns)} onFill={noop} />).container)
    expect(view.queryByRole('button', { name: 'Generate with AI' })).toBeNull()
  })

  it('ticking Options in the row and pressing Fill ticks exactly those boxes on the page', async () => {
    const source = only(scan('lever-source-group'), /how did you hear about us/i)
    const fills: Promise<unknown>[] = []
    const view = within(render(<Panel field={source} resolution={needsInput(source)} onFill={(value) => {
      fills.push(fillFields(document, [{ handle: { frameId: 0, fid: source.fid, epoch: 1 }, value }]))
    }} />).container)
    fireEvent.click(view.getByRole('checkbox', { name: 'LinkedIn' }))
    fireEvent.click(view.getByRole('checkbox', { name: 'Employee Referral' }))
    fireEvent.click(view.getByRole('button', { name: 'Fill' }))
    await Promise.all(fills)
    expect(fills).toHaveLength(1)
    expect(pageBox('LinkedIn').checked).toBe(true)
    expect(pageBox('Employee Referral').checked).toBe(true)
    expect(pageBox('Other').checked).toBe(false)
  })

  it('a hidden checkbox group with a label is kept as a row', () => {
    const pronouns = only(scan('lever-pronoun-group'), /^pronouns$/i)
    expect(dropJunk([{ ...pronouns, visible: false }])).toHaveLength(1)
  })

  it('a checkbox group under a demographic heading is one Skipped row', () => {
    document.documentElement.innerHTML = `<head></head><body><form>
      <section class="eeo-section"><h4>Voluntary self-identification</h4>
        <div><div>Which of these describe you?</div><ul>
          <li><label><input type="checkbox" name="eeo_q"> Option A</label></li>
          <li><label><input type="checkbox" name="eeo_q"> Option B</label></li>
        </ul></div>
      </section></form></body>`
    const fields = enumerateFields({
      root: document, epoch: 1, measure: allVisible,
      isDemographic: (el) => isDemographic(el, { isSubframe: false }),
    }).fields
    expect(fields).toHaveLength(1)
    const group = fields[0]!
    const view = within(render(<Panel field={group} resolution={needsInput(group, { tier: 'skipped', reason: 'eeo' })} onFill={noop} />).container)
    const rows = view.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.getAttribute('data-jff-tier')).toBe('skipped')
    expect(within(rows[0]!).getByText('Which of these describe you?')).toBeTruthy()
    expect(within(rows[0]!).queryByRole('checkbox')).toBeNull()
  })
})

describe('a Consent checkbox row shows one tick box', () => {
  it('the Consent row shows one tick box in place of the text area, and no Generate with AI', () => {
    const consent = only(scan('lever-pronoun-group'), /consent to contact me/i)
    const view = within(render(<Panel field={consent} resolution={needsInput(consent, { reason: 'consent-checkbox' })} onFill={noop} />).container)
    expect(view.getAllByRole('checkbox')).toHaveLength(1)
    expect(view.queryByRole('textbox')).toBeNull()
    expect(view.queryByRole('button', { name: 'Generate with AI' })).toBeNull()
  })

  it('ticking the Consent row and pressing Fill checks the box on the page', async () => {
    const consent = only(scan('lever-pronoun-group'), /consent to contact me/i)
    let done: Promise<{ filled: unknown[] }> | null = null
    const view = within(render(<Panel field={consent} resolution={needsInput(consent, { reason: 'consent-checkbox' })} onFill={(value) => {
      done = fillFields(document, [{ handle: { frameId: 0, fid: consent.fid, epoch: 1 }, value }])
    }} />).container)
    const fill = view.getByRole('button', { name: 'Fill' }) as HTMLButtonElement
    expect(fill.disabled).toBe(true)
    fireEvent.click(view.getByRole('checkbox', { name: /consent to contact me/i }))
    expect(fill.disabled).toBe(false)
    fireEvent.click(fill)
    await waitFor(() => expect(done).not.toBeNull())
    const report = await done!
    expect(report.filled).toHaveLength(1)
    const box = document.querySelector<HTMLInputElement>('form input[type="checkbox"][name="consent[marketing]"]')!
    expect(box.checked).toBe(true)
  })
})
