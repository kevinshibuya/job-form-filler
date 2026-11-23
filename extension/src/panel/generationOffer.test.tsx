import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ACCOMMODATION_REASON, type EnumField, type HostResponse, type Resolution } from '@jff/shared'
import { App } from './App'
import { ACCOMMODATION_HINT } from './FieldRow'
import { field, installHeldMappingHost, mapped, release, resolution, rowLabels, rowOf, status } from './testing/heldMapping'

/**
 * Where Generation is offered, at the panel seam: the App renders against a
 * fake Native host whose Mapping reply labels each Field it matched to nothing.
 * Generation is offered on every Needs input Field with no Known key on a text
 * Control, whatever its label, except a question about accommodation needs,
 * which the host marks with its own reason (ADR 0014).
 */

const WHY = 'Why do you want this role?'
const PROJECT = 'Tell us about a project you led'
const ACCOMMODATION = 'Do you need any accommodation during the interview process?'
const TEAM = 'Which team appeals to you most?'
const STYLE = 'How do you like to work?'
const SQL = 'Rate your SQL'
const LANGS = 'Which languages do you speak?'
const CONSENT = 'I agree to the privacy policy'
const SALARY = 'Salary expectation'
const VERSIONS = 'Which versions of TypeScript have you worked with?'
const ONSITE = 'Can you be on site one day a week?'

const PAGE: EnumField[] = [
  field(0, WHY, { kind: 'textarea' }),
  field(1, PROJECT, { kind: 'text' }),
  field(2, ACCOMMODATION, { kind: 'textarea' }),
  field(3, TEAM, { kind: 'select', options: ['Platform', 'Product'] }),
  field(4, STYLE, { kind: 'radiogroup', options: ['Alone', 'In a pair', 'In a team'] }),
  field(5, SQL, { kind: 'select', options: ['1', '2', '3', '4', '5'] }),
  field(6, LANGS, { kind: 'checkboxgroup', options: ['English', 'French', 'Italian'] }),
  field(7, CONSENT, { kind: 'checkbox' }),
  field(8, SALARY, { kind: 'text' }),
  field(9, VERSIONS, { kind: 'text' }),
  field(10, ONSITE, { kind: 'textarea' }),
]

/**
 * What the host decides after Mapping. The two choice Controls Mapping labels
 * prose, to prove the Control rule holds on its own. The accommodation
 * question it labels prose too: the host's rule on its wording gives it its
 * own reason whatever the label.
 */
const mappingFor = (fields: EnumField[]): Resolution[] => fields.map((f) => {
  switch (f.fid) {
    case 0: case 1: case 3: case 4: case 6:
      return resolution(f, { fieldClass: 'prose' })
    case 2:
      return resolution(f, { fieldClass: 'prose', reason: ACCOMMODATION_REASON })
    case 9:
      return resolution(f, { fieldClass: 'personal_fact' })
    case 8:
      return resolution(f, { key: 'salary', reason: 'llm-key:salary:no-stored-value' })
    default:
      // No label: a self-rating, and a text question Mapping did not label.
      return resolution(f, {})
  }
})

const host = installHeldMappingHost()
let generated: string[]
let saves: { questionRaw: string; answer: string }[][]

beforeEach(() => {
  host.fields = PAGE
  // The Consent checkbox is decided by the first step, as the real host does.
  host.firstNeedsInput = [7]
  host.mappingFor = mappingFor
  generated = []
  saves = []
  const base = window.__jffHostBridge!
  window.__jffHostBridge = async (req): Promise<HostResponse> => {
    if (req.method === 'generate') {
      const q = (req.params as { questionRaw: string }).questionRaw
      generated.push(q)
      return { requestId: req.requestId, ok: true, result: { draft: `Draft for: ${q}` } }
    }
    if (req.method === 'save') {
      saves.push((req.params as { items: { questionRaw: string; answer: string }[] }).items)
      return { requestId: req.requestId, ok: true, result: { saved: 1 } }
    }
    return await base(req)
  }
})

async function mountMapped(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(host.held).toHaveLength(1) })
  await release(host, (h) => mapped(host, h))
  await waitFor(() => { expect(rowLabels()).toHaveLength(PAGE.length) })
  await waitFor(() => { expect(status()).toBe('done') })
}

const generateIn = (label: string) =>
  within(rowOf(label) as HTMLElement).queryByRole('button', { name: 'Generate with AI' })
const generateAll = () => document.querySelector('[data-jff-generate-all] button')
const hintIn = (label: string) => rowOf(label)?.querySelector('[data-jff-hint]')?.textContent

/** Every text question but the accommodation one, in page order. */
const DRAFTABLE = [WHY, PROJECT, VERSIONS, ONSITE]

describe('Generation is offered on every unanswered text question', () => {
  it('shows Generate with AI on a Prose Field on a text area or a text box', async () => {
    await mountMapped()
    expect(generateIn(WHY)).not.toBeNull()
    expect(generateIn(PROJECT)).not.toBeNull()
  })

  it('shows it on a Personal-fact Field on a text box, and on a text question Mapping gave no label', async () => {
    await mountMapped()
    expect(generateIn(VERSIONS)).not.toBeNull()
    expect(generateIn(ONSITE)).not.toBeNull()
  })

  it('does not show it on a Field drawn as a dropdown or a radio group, whatever its label', async () => {
    await mountMapped()
    expect(generateIn(TEAM)).toBeNull()
    expect(generateIn(STYLE)).toBeNull()
  })

  it('shows no Generation on a question about accommodation needs, says it is the user\'s, and gives a place to type', async () => {
    await mountMapped()
    expect(generateIn(ACCOMMODATION)).toBeNull()
    expect(hintIn(ACCOMMODATION)).toBe(ACCOMMODATION_HINT)
    const box = screen.getByLabelText(ACCOMMODATION)
    expect(box.tagName).toBe('TEXTAREA')
    fireEvent.change(box, { target: { value: 'A quiet room, please.' } })
    expect((screen.getByLabelText(ACCOMMODATION) as HTMLTextAreaElement).value).toBe('A quiet room, please.')
  })

  it('shows no Generation on a dropdown with no stored Value, a checkbox group, a Consent checkbox or a keyed Field', async () => {
    await mountMapped()
    for (const label of [SQL, LANGS, CONSENT, SALARY]) {
      expect(rowOf(label)?.getAttribute('data-jff-tier')).toBe('needs_input')
      expect(generateIn(label)).toBeNull()
    }
  })

  it('never shows the old hint that a question about the user is theirs to answer', async () => {
    await mountMapped()
    expect(document.body.textContent).not.toContain('A question about you. Answer it yourself.')
  })

  it('counts and drafts exactly the rows that offer Generation with Generate all remaining', async () => {
    await mountMapped()
    expect(generateAll()?.textContent).toBe(`Generate all remaining (${DRAFTABLE.length})`)
    fireEvent.click(generateAll()!)
    await waitFor(() => { expect(generated).toHaveLength(DRAFTABLE.length) })
    await waitFor(() => { expect(generateAll()).toBeNull() })
    expect([...generated].sort()).toEqual([...DRAFTABLE].sort())
    expect(generated).not.toContain(ACCOMMODATION)
    expect((screen.getByLabelText(WHY) as HTMLTextAreaElement).value).toBe(`Draft for: ${WHY}`)
    expect((screen.getByLabelText(VERSIONS) as HTMLInputElement).value).toBe(`Draft for: ${VERSIONS}`)
  })

  it('stops counting a row the user has answered', async () => {
    await mountMapped()
    fireEvent.change(screen.getByLabelText(PROJECT), { target: { value: 'The analytical engine notes.' } })
    expect(generateAll()?.textContent).toBe(`Generate all remaining (${DRAFTABLE.length - 1})`)
  })

  it('keeps every text question draftable when Mapping fails, except the accommodation question', async () => {
    render(<App />)
    await waitFor(() => { expect(host.held).toHaveLength(1) })
    await release(host, (h) => mapped(host, h, { kind: 'rate_limit', message: 'limit' }))
    await waitFor(() => { expect(rowLabels()).toHaveLength(PAGE.length) })
    // With no Mapping, the salary box has no Known key either: one more text question.
    const draftable = [...DRAFTABLE, SALARY]
    for (const label of draftable) expect(generateIn(label), label).not.toBeNull()
    expect(generateIn(ACCOMMODATION)).toBeNull()
    expect(hintIn(ACCOMMODATION)).toBe(ACCOMMODATION_HINT)
    expect(generateAll()?.textContent).toBe(`Generate all remaining (${draftable.length})`)
  })

  it('withholds Generation from an accommodation question the Mapping reply left out', async () => {
    host.mappingFor = (fields) => mappingFor(fields.filter((f) => f.fid !== 2))
    await mountMapped()
    expect(rowOf(ACCOMMODATION)?.getAttribute('data-jff-tier')).toBe('needs_input')
    expect(generateIn(ACCOMMODATION)).toBeNull()
    expect(hintIn(ACCOMMODATION)).toBe(ACCOMMODATION_HINT)
    expect(generateAll()?.textContent).toBe(`Generate all remaining (${DRAFTABLE.length})`)
  })

  it('keeps an answer typed into a Personal-fact row as a Saved answer on save', async () => {
    await mountMapped()
    fireEvent.change(screen.getByLabelText(VERSIONS), { target: { value: 'TypeScript 4 and 5.' } })
    fireEvent.change(screen.getByLabelText(ACCOMMODATION), { target: { value: 'A quiet room, please.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save answers' }))
    await waitFor(() => { expect(saves).toHaveLength(1) })
    expect(saves[0]).toContainEqual(expect.objectContaining({ questionRaw: VERSIONS, answer: 'TypeScript 4 and 5.' }))
    expect(saves[0]).toContainEqual(expect.objectContaining({ questionRaw: ACCOMMODATION, answer: 'A quiet room, please.' }))
  })
})

/**
 * A missed Fill replaces a row's reason with the page's, so the rule that
 * withholds Generation from an accommodation question reads the label too
 * (review of PR #112, finding 1).
 */
describe('an accommodation question whose Fill missed', () => {
  const ROOM = 'A quiet room, please.'

  beforeEach(() => {
    host.nothingPending = true
    host.fields = [field(0, ACCOMMODATION, { kind: 'textarea' }), field(1, WHY, { kind: 'textarea' })]
  })

  it('offers no Generation when a matched Saved answer misses on the first Fill', async () => {
    // A Reusable Saved answer matched both questions outright, so neither row
    // ever carried the accommodation reason; the page refuses both Fills.
    host.firstValues = { 0: ROOM, 1: 'Because of the engines.' }
    host.firstPatch = { 0: { source: 'answer', answerId: 1 }, 1: { source: 'answer', answerId: 2 } }
    host.refuse = { 0: 'element-not-found', 1: 'element-not-found' }
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    await waitFor(() => { expect(rowOf(ACCOMMODATION)?.getAttribute('data-jff-tier')).toBe('needs_input') })
    expect(rowOf(WHY)?.getAttribute('data-jff-tier')).toBe('needs_input')
    // The other question proves the miss opens Generation on an ordinary row.
    expect(generateIn(WHY)).not.toBeNull()
    expect(generateIn(ACCOMMODATION)).toBeNull()
    expect(rowOf(ACCOMMODATION)?.textContent).toContain(ACCOMMODATION_HINT)
    expect(generateAll()?.textContent).toBe('Generate all remaining (1)')
  })

  it('offers no Generation when the user\'s own answer misses on Fill', async () => {
    host.firstNeedsInput = [0, 1]
    host.firstPatch = { 0: { reason: ACCOMMODATION_REASON } }
    host.refuse = { 0: 'element-not-found' }
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    expect(generateIn(ACCOMMODATION)).toBeNull()
    fireEvent.change(screen.getByLabelText(ACCOMMODATION), { target: { value: ROOM } })
    fireEvent.click(within(rowOf(ACCOMMODATION) as HTMLElement).getByRole('button', { name: 'Fill' }))
    await waitFor(() => { expect(rowOf(ACCOMMODATION)?.textContent).toContain('element-not-found') })
    expect(generateIn(ACCOMMODATION)).toBeNull()
    expect(rowOf(ACCOMMODATION)?.textContent).toContain(ACCOMMODATION_HINT)
    expect(generateAll()?.textContent).toBe('Generate all remaining (1)')
  })
})
