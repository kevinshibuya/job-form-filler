import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { EnumField, HostResponse, Resolution } from '@jff/shared'
import { App } from './App'
import { field, installHeldMappingHost, mapped, release, resolution, rowLabels, rowOf, status } from './testing/heldMapping'

/**
 * Where Generation is offered, at the panel seam: the App renders against a
 * fake Native host whose Mapping reply labels each Field it matched to nothing.
 * Generation is offered on a Needs input Prose Field on a text Control and
 * nowhere else; every other row is the user's to answer.
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
]

/** What Mapping decides. The two choice Controls it labels prose, to prove the Control rule holds on its own. */
const mappingFor = (fields: EnumField[]): Resolution[] => fields.map((f) => {
  switch (f.fid) {
    case 0: case 1: case 3: case 4: case 6:
      return resolution(f, { fieldClass: 'prose' })
    case 2:
      return resolution(f, { fieldClass: 'personal_fact' })
    case 8:
      return resolution(f, { key: 'salary', reason: 'llm-key:salary:no-stored-value' })
    default:
      // No label: a self-rating Mapping did not label is a Personal-fact Field.
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

describe('Generation is offered only on a Prose Field', () => {
  it('shows Generate with AI on a Prose Field on a text area or a text box', async () => {
    await mountMapped()
    expect(generateIn(WHY)).not.toBeNull()
    expect(generateIn(PROJECT)).not.toBeNull()
  })

  it('does not show it on a Prose Field drawn as a dropdown or a radio group', async () => {
    await mountMapped()
    expect(generateIn(TEAM)).toBeNull()
    expect(generateIn(STYLE)).toBeNull()
  })

  it('shows no Generation on a question about accommodation needs, and a place to type', async () => {
    await mountMapped()
    expect(generateIn(ACCOMMODATION)).toBeNull()
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

  it('counts and drafts exactly the Prose Fields on text Controls with Generate all remaining', async () => {
    await mountMapped()
    expect(generateAll()?.textContent).toBe('Generate all remaining (2)')
    fireEvent.click(generateAll()!)
    await waitFor(() => { expect(generated).toHaveLength(2) })
    await waitFor(() => { expect(generateAll()).toBeNull() })
    expect(generated).toEqual([WHY, PROJECT])
    expect((screen.getByLabelText(WHY) as HTMLTextAreaElement).value).toBe(`Draft for: ${WHY}`)
  })

  it('stops counting a Prose Field the user has answered', async () => {
    await mountMapped()
    fireEvent.change(screen.getByLabelText(PROJECT), { target: { value: 'The analytical engine notes.' } })
    expect(generateAll()?.textContent).toBe('Generate all remaining (1)')
  })

  it('treats every Field as a Personal-fact Field when Mapping fails', async () => {
    render(<App />)
    await waitFor(() => { expect(host.held).toHaveLength(1) })
    await release(host, (h) => mapped(host, h, { kind: 'rate_limit', message: 'limit' }))
    await waitFor(() => { expect(rowLabels()).toHaveLength(PAGE.length) })
    expect(generateIn(WHY)).toBeNull()
    expect(generateIn(PROJECT)).toBeNull()
    expect(generateAll()).toBeNull()
  })

  it('keeps an answer typed into a Personal-fact row as a Saved answer on save', async () => {
    await mountMapped()
    fireEvent.change(screen.getByLabelText(ACCOMMODATION), { target: { value: 'A quiet room, please.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save answers' }))
    await waitFor(() => { expect(saves).toHaveLength(1) })
    expect(saves[0]).toContainEqual(expect.objectContaining({ questionRaw: ACCOMMODATION, answer: 'A quiet room, please.' }))
  })
})
