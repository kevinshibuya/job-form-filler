import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { EnumField, HostResponse, KeptProseAnswer, Resolution } from '@jff/shared'
import { App } from './App'
import { field, installHeldMappingHost, mapped, release, resolution, rowLabels, rowOf, status } from './testing/heldMapping'

/**
 * What a form Applied job keeps (spec #66), at the panel seam: the whole App
 * against a fake Native host. Mark applied, from its button or from the
 * Submission detection prompt, carries the channel and, for each Prose Field
 * with a final text, the question, the text the Session holds, whether AI
 * drafted it, whether the user changed the Draft and which model wrote it.
 */

const EDITED = 'Why do you want to work here?'
const DRAFTED = 'What would you change in your first month?'
const OWN = 'Tell us about a project you led'
const EMPTY = 'Anything else we should know?'
const MODEL = 'claude-test-writer'

const DRAFTS: Record<string, string> = {
  [EDITED]: 'I like the work Acme does.',
  [DRAFTED]: 'I would read the analytical engine notes first.',
}
const EDITED_TEXT = 'I like the work Acme does on the analytical engine.'
const OWN_TEXT = 'I wrote the first published algorithm.'

const PAGE: EnumField[] = [
  field(0, EDITED, { kind: 'textarea' }),
  field(1, DRAFTED, { kind: 'textarea' }),
  field(2, OWN, { kind: 'textarea' }),
  field(3, EMPTY, { kind: 'textarea' }),
]
const mappingFor = (fields: EnumField[]): Resolution[] => fields.map((f) => resolution(f, { fieldClass: 'prose' }))

const EXPECTED: KeptProseAnswer[] = [
  { question: EDITED, text: EDITED_TEXT, aiDrafted: true, edited: true, model: MODEL, kind: 'prose' },
  { question: DRAFTED, text: DRAFTS[DRAFTED]!, aiDrafted: true, edited: false, model: MODEL, kind: 'prose' },
  { question: OWN, text: OWN_TEXT, aiDrafted: false, edited: false, model: null, kind: 'prose' },
]

const host = installHeldMappingHost()
let marks: Record<string, unknown>[]

beforeEach(() => {
  marks = []
  host.fields = PAGE
  host.mappingFor = mappingFor
  const base = window.__jffHostBridge!
  window.__jffHostBridge = async (req): Promise<HostResponse> => {
    if (req.method === 'generate') {
      const q = (req.params as { questionRaw: string }).questionRaw
      return { requestId: req.requestId, ok: true, result: { draft: DRAFTS[q], model: MODEL } }
    }
    if (req.method === 'applied.check') return { requestId: req.requestId, ok: true, result: { applied: null } }
    if (req.method === 'applied.mark') {
      marks.push(req.params as Record<string, unknown>)
      return { requestId: req.requestId, ok: true, result: { id: 1, markedAt: '2026-11-18T12:00:00.000Z', channel: 'form' } }
    }
    return await base(req)
  }
})

const editor = (label: string): HTMLTextAreaElement => screen.getByLabelText(label) as HTMLTextAreaElement

async function generate(label: string): Promise<void> {
  fireEvent.click(within(rowOf(label) as HTMLElement).getByRole('button', { name: 'Generate with AI' }))
  await waitFor(() => { expect(editor(label).value).toBe(DRAFTS[label]) })
}

/** Scan the page, then answer it: one Draft changed, one Draft kept, one text
 *  written by hand, and one Prose Field left empty. */
async function answerThePage(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(host.held).toHaveLength(1) })
  await release(host, (h) => mapped(host, h))
  await waitFor(() => { expect(rowLabels()).toHaveLength(PAGE.length) })
  await waitFor(() => { expect(status()).toBe('done') })
  await generate(EDITED)
  fireEvent.change(editor(EDITED), { target: { value: EDITED_TEXT } })
  await generate(DRAFTED)
  fireEvent.change(editor(OWN), { target: { value: OWN_TEXT } })
  await waitFor(() => { expect(editor(OWN).value).toBe(OWN_TEXT) })
}

const proseAnswersOf = (m: Record<string, unknown>): KeptProseAnswer[] => m.proseAnswers as KeptProseAnswer[]

describe('Mark applied keeps the prose answers of a form application', () => {
  it('sends the form channel and each answered Prose Field with its question, final text and marks', async () => {
    await answerThePage()
    fireEvent.click(screen.getByRole('button', { name: 'Mark applied' }))
    await waitFor(() => { expect(marks).toHaveLength(1) })
    expect(marks[0]).toMatchObject({ url: 'https://jobs.example.com/apply', channel: 'form' })
    const kept = proseAnswersOf(marks[0]!)
    // An empty Prose Field sends nothing.
    expect(kept).toHaveLength(EXPECTED.length)
    expect(kept).toEqual(expect.arrayContaining(EXPECTED))
    expect(kept.map((a) => a.question)).not.toContain(EMPTY)
  })

  it('counts a Draft the user changed and changed back as not edited', async () => {
    await answerThePage()
    fireEvent.change(editor(EDITED), { target: { value: DRAFTS[EDITED] } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark applied' }))
    await waitFor(() => { expect(marks).toHaveLength(1) })
    expect(proseAnswersOf(marks[0]!).find((a) => a.question === EDITED))
      .toEqual({ question: EDITED, text: DRAFTS[EDITED], aiDrafted: true, edited: false, model: MODEL, kind: 'prose' })
  })

  it('sends the same from the Submission detection prompt, after the page lost its form', async () => {
    await answerThePage()
    // The form is submitted: the next page on the same site has no Fields.
    host.fields = []
    const onCommitted = (globalThis as unknown as {
      chrome: { webNavigation: { onCommitted: { addListener: ReturnType<typeof vi.fn> } } }
    }).chrome.webNavigation.onCommitted.addListener
    await waitFor(() => { expect(onCommitted.mock.calls.length).toBeGreaterThan(0) })
    const listener = onCommitted.mock.calls[0]![0] as (d: { tabId: number; frameId: number; url: string }) => void
    await act(async () => { listener({ tabId: 7, frameId: 0, url: 'https://jobs.example.com/apply/done' }) })
    await waitFor(() => { expect(document.querySelector('[data-jff-submit-prompt]')).not.toBeNull() }, { timeout: 3000 })
    expect(marks).toHaveLength(0)
    fireEvent.click(document.querySelector('[data-jff-prompt-mark]')!)
    await waitFor(() => { expect(marks).toHaveLength(1) })
    expect(marks[0]).toMatchObject({ url: 'https://jobs.example.com/apply', channel: 'form' })
    const kept = proseAnswersOf(marks[0]!)
    expect(kept).toHaveLength(EXPECTED.length)
    expect(kept).toEqual(expect.arrayContaining(EXPECTED))
  })
})
