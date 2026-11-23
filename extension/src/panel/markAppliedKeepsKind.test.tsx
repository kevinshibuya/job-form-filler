import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ACCOMMODATION_REASON, AppliedTextsSchema, type EnumField, type HostResponse, type KeptProseAnswer, type Resolution } from '@jff/shared'
import { App } from './App'
import type { AppliedJobRow } from './ApplicationsView'
import { field, installHeldMappingHost, mapped, release, resolution, rowLabels, rowOf, status } from './testing/heldMapping'

/**
 * Ticket #107, at the panel seam: the whole App against a fake Native host.
 * Mark applied keeps the answer of every row that offered Generation, Prose
 * and Personal-fact alike, each with its kind, and an answer from an earlier
 * step of the same application. A choice Control, a keyed Field and an
 * accommodation row keep nothing. A kept answer the Native host returns with
 * no kind reads as prose, and the Applied job's texts still show.
 */

const PROSE = 'Why do you want to work here?'
const FACT = 'Which versions of the analytical engine have you worked with?'
const UNLABELLED = 'Can you work on site one day a week?'
const CHOICE = 'How did you hear about us?'
const KEYED = 'Your LinkedIn profile'
const ACCOMMODATION = 'Do you need any accommodation for the interview?'
const EARLIER = 'Which tools do you use to keep notes?'
const MODEL = 'claude-test-writer'

const DRAFTS: Record<string, string> = {
  [PROSE]: 'I like the work Acme does on the analytical engine.',
  [FACT]: 'The first.',
}
const FACT_TEXT = 'The first and the second.'
const UNLABELLED_TEXT = 'Yes, on Tuesdays.'
const EARLIER_TEXT = 'A paper notebook.'

const PAGE: EnumField[] = [
  field(0, PROSE, { kind: 'textarea' }),
  field(1, FACT, { kind: 'text' }),
  field(2, UNLABELLED, { kind: 'textarea' }),
  field(3, CHOICE, { kind: 'select', options: ['A friend', 'A job board'] }),
  field(4, KEYED, { kind: 'text' }),
  field(5, ACCOMMODATION, { kind: 'textarea' }),
]
const STEP_ONE: EnumField[] = [field(0, EARLIER, { kind: 'text' })]

/** Mapping as the real host gives it: a label on every Field it matched to
 *  nothing, but none on UNLABELLED, and the accommodation row its own reason. */
const mappingFor = (fields: EnumField[]): Resolution[] => fields.map((f) => {
  if (f.label === PROSE) return resolution(f, { fieldClass: 'prose' })
  if (f.label === UNLABELLED) return resolution(f, {})
  if (f.label === ACCOMMODATION) return resolution(f, { fieldClass: 'personal_fact', reason: ACCOMMODATION_REASON })
  return resolution(f, { fieldClass: 'personal_fact' })
})

const host = installHeldMappingHost()
let marks: Record<string, unknown>[]

beforeEach(() => {
  marks = []
  host.fields = PAGE
  host.mappingFor = mappingFor
  // The LinkedIn Field is keyed by the first Resolution step, with nothing stored.
  host.firstNeedsInput = [4]
  host.firstPatch = { 4: { key: 'linkedin', reason: 'recognizer:no-stored-value' } }
  const base = window.__jffHostBridge!
  window.__jffHostBridge = async (req): Promise<HostResponse> => {
    if (req.method === 'generate') {
      const q = (req.params as { questionRaw: string }).questionRaw
      return { requestId: req.requestId, ok: true, result: { draft: DRAFTS[q], model: MODEL } }
    }
    if (req.method === 'applied.mark') {
      marks.push(req.params as Record<string, unknown>)
      return { requestId: req.requestId, ok: true, result: { id: 1, markedAt: '2026-11-23T12:00:00.000Z', channel: 'form' } }
    }
    return await base(req)
  }
})

const editor = (label: string): HTMLInputElement | HTMLTextAreaElement =>
  screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement

async function scanned(fields: EnumField[]): Promise<void> {
  await waitFor(() => { expect(host.held.length).toBeGreaterThan(0) })
  await release(host, (h) => mapped(host, h))
  await waitFor(() => { expect(rowLabels()).toHaveLength(fields.length) })
  await waitFor(() => { expect(status()).toBe('done') })
}

async function generate(label: string): Promise<void> {
  fireEvent.click(within(rowOf(label) as HTMLElement).getByRole('button', { name: 'Generate with AI' }))
  await waitFor(() => { expect(editor(label).value).toBe(DRAFTS[label]) })
}

function type(label: string, text: string): void {
  fireEvent.change(editor(label), { target: { value: text } })
}

/** Answer every row of the page: a Prose Draft kept, a Personal-fact Draft
 *  edited, a text written on the row with no label, an Option picked, the
 *  keyed Field and the accommodation row written by hand. */
async function answerThePage(): Promise<void> {
  await generate(PROSE)
  await generate(FACT)
  type(FACT, FACT_TEXT)
  type(UNLABELLED, UNLABELLED_TEXT)
  fireEvent.click(within(rowOf(CHOICE) as HTMLElement).getByRole('button', { name: 'A friend' }))
  type(KEYED, 'https://www.linkedin.com/in/ada-example')
  type(ACCOMMODATION, 'None needed.')
  await waitFor(() => { expect(editor(ACCOMMODATION).value).toBe('None needed.') })
}

async function markApplied(): Promise<KeptProseAnswer[]> {
  fireEvent.click(screen.getByRole('button', { name: 'Mark applied' }))
  await waitFor(() => { expect(marks).toHaveLength(1) })
  expect(marks[0]).toMatchObject({ channel: 'form' })
  return marks[0]!.proseAnswers as KeptProseAnswer[]
}

const KEPT_ON_PAGE: KeptProseAnswer[] = [
  { question: PROSE, text: DRAFTS[PROSE]!, aiDrafted: true, edited: false, model: MODEL, kind: 'prose' },
  { question: FACT, text: FACT_TEXT, aiDrafted: true, edited: true, model: MODEL, kind: 'personal_fact' },
  { question: UNLABELLED, text: UNLABELLED_TEXT, aiDrafted: false, edited: false, model: null, kind: 'personal_fact' },
]

describe('Mark applied keeps each answer of a row that offered Generation with its kind', () => {
  it('sends the Prose and Personal-fact answers with their questions, final texts, marks and kinds, and nothing else', async () => {
    render(<App />)
    await scanned(PAGE)
    await answerThePage()
    const kept = await markApplied()
    expect(kept).toHaveLength(KEPT_ON_PAGE.length)
    expect(kept).toEqual(expect.arrayContaining(KEPT_ON_PAGE))
    for (const label of [CHOICE, KEYED, ACCOMMODATION]) expect(kept.map((a) => a.question)).not.toContain(label)
  }, 20_000)

  it('sends an answer given on an earlier step of the same application with its kind', async () => {
    host.fields = STEP_ONE
    render(<App />)
    await scanned(STEP_ONE)
    type(EARLIER, EARLIER_TEXT)
    await waitFor(() => { expect(editor(EARLIER).value).toBe(EARLIER_TEXT) })
    // The next step of the wizard: the earlier question's row is gone.
    host.fields = PAGE
    const before = host.held.length
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    await waitFor(() => { expect(host.held.length).toBe(before + 1) })
    await scanned(PAGE)
    expect(rowLabels()).not.toContain(EARLIER)
    await answerThePage()
    const kept = await markApplied()
    expect(kept).toContainEqual(
      { question: EARLIER, text: EARLIER_TEXT, aiDrafted: false, edited: false, model: null, kind: 'personal_fact' },
    )
    expect(kept).toEqual(expect.arrayContaining(KEPT_ON_PAGE))
  }, 25_000)
})

describe('a Native host that returns kept answers with no kind', () => {
  const EMAIL_JOB: AppliedJobRow = {
    id: 2, url: 'https://careers.example.com/jobs/2', canonicalUrl: 'https://careers.example.com/jobs/2',
    company: 'Example Ltd', jobTitle: 'Analyst', markedAt: '2026-11-18T12:00:00.000Z', channel: 'email',
  }
  const SUBJECT = 'Application: Analyst'

  it('is read as prose, and the Applied job\'s texts still show', async () => {
    // An older Native host: its kept answers carry no kind.
    const reply = {
      id: EMAIL_JOB.id,
      proseAnswers: [{ question: PROSE, text: DRAFTS[PROSE], aiDrafted: true, edited: false, model: MODEL }],
      emails: [{
        applyAddress: 'jobs@example.org', senderAddress: null, subject: SUBJECT,
        body: 'Hello,\n\nI would like to apply.\n\nBest regards,\nAda Lovelace', attachmentNames: [],
        sentAt: '2026-11-18T12:00:00.000Z', language: 'en', gmailMessageId: null, gmailThreadId: null,
        route: 'mail_app', aiDrafted: true, edited: false, model: 'claude-opus-5-5',
      }],
    }
    // The schema the Side panel reads `applied.get` with.
    expect(AppliedTextsSchema.parse(reply).proseAnswers.map((a) => a.kind)).toEqual(['prose'])
    const base = window.__jffHostBridge!
    window.__jffHostBridge = async (req): Promise<HostResponse> => {
      if (req.method === 'applied.list') return { requestId: req.requestId, ok: true, result: { jobs: [EMAIL_JOB] } }
      if (req.method === 'applied.get') return { requestId: req.requestId, ok: true, result: reply }
      return await base(req)
    }
    render(<App />)
    await waitFor(() => { expect(document.querySelector('[data-jff-nav-apps]')).not.toBeNull() }, { timeout: 8_000 })
    fireEvent.click(document.querySelector('[data-jff-nav-apps]')!)
    await waitFor(() => { expect(document.querySelector('[data-jff-apps="1"]')).not.toBeNull() })
    const row = [...document.querySelectorAll<HTMLElement>('[data-jff-apps] li')].find((li) => li.textContent?.includes('Analyst'))!
    fireEvent.click(within(row).getByRole('button', { name: 'Show the Application email' }))
    await waitFor(() => { expect(document.querySelector('[data-jff-app-email-subject]')?.textContent).toBe(SUBJECT) })
  }, 20_000)
})
