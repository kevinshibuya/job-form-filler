import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FoundAddress } from '@jff/shared'
import { App } from './App'
import { pageSubjectFor } from './emailDraft'
import { saveResume } from './resume'
import type { Session } from './sessions'
import { DRAFT_PROSE, draftReply, installHeldMappingHost, status } from './testing/heldMapping'

/**
 * The Application email in the Side panel (spec #66, ticket #72). Once the
 * Apply address is chosen, by the pick, from the list or by typing, the panel
 * asks the Native host for one Draft and shows it for Review: To, subject,
 * body and the attachment. The Session keeps the Draft with its flags, its
 * model and the edited mark. The App renders against a fake Native host.
 */

const host = installHeldMappingHost()

const PAGE: FoundAddress[] = [
  { address: 'privacy@example.org', context: { kind: 'text', sentence: 'For privacy questions write to privacy@example.org.' } },
  { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' } },
  { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Send your CV', subject: 'Analyst role' } },
]
const JOB_TEXT = 'Acme is hiring an analyst to build analytical engines. '.repeat(10).trim()

function onCareersTab(): void {
  const tab = { id: 7, url: 'https://careers.example.com/jobs/1', title: 'Analyst at Acme' }
  const chrome = (globalThis as unknown as { chrome: { tabs: { query: unknown; get: unknown } } }).chrome
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
}

const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined
const draftRequests = (): number => host.methods.filter((m) => m === 'email.draft').length
const subjectInput = (): HTMLInputElement | null => document.querySelector('[data-jff-email-subject] input')
const bodyInput = (): HTMLTextAreaElement | null => document.querySelector('[data-jff-email-body] textarea')
const typedInput = (): HTMLInputElement | null => document.querySelector('[data-jff-email-typed] input')
const pasteBox = (): HTMLTextAreaElement => document.querySelector('[data-jff-paste] textarea') as HTMLTextAreaElement
const useAddress = (address: string): void => {
  fireEvent.click(within(document.querySelector(`[data-jff-candidate="${address}"]`) as HTMLElement).getByRole('button', { name: 'Use this address' }))
}

async function scanEmailPage(opts: { jobText?: boolean } = {}): Promise<ReturnType<typeof render>> {
  onCareersTab()
  host.addresses = PAGE
  if (opts.jobText !== false) host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
  const out = render(<App />)
  await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
  return out
}

/** The pick points at jobs@example.org. */
const pickJobs = (): void => {
  host.addressPick = (p) => ({ position: p.candidates.findIndex((c) => c.address === 'jobs@example.org') })
}

describe('the Draft starts once the Apply address is chosen', () => {
  it('by the pick: one request, with the job text, the Company, the title, the Resume text and the page subject', async () => {
    await saveResume(new File(['%PDF-1.4'], 'ada-cv.pdf', { type: 'application/pdf' }), async () => 'Analyst at Example Ltd, 2019 to 2024.')
    pickJobs()
    await scanEmailPage()
    await waitFor(() => { expect(host.emailDrafts).toHaveLength(1) })
    const sent = host.emailDrafts[0]!
    expect(sent.jobText).toBe(JOB_TEXT)
    expect(sent.company).toBe('Acme')
    expect(sent.title).toBe('Analyst at Acme')
    expect(sent.cvText).toBe('Analyst at Example Ltd, 2019 to 2024.')
    // Two links to the address carry different subjects: the first in page order wins.
    expect(sent.pageSubject).toBe('Application: Analyst')
    await waitFor(() => { expect(subjectInput()?.value).toBe('Application: Analyst') })
    expect(bodyInput()?.value).toContain(DRAFT_PROSE)
    expect(draftRequests()).toBe(1)
  }, 15_000)

  it('from the list: one request', async () => {
    await scanEmailPage()
    await waitFor(() => { expect(document.querySelector('[data-jff-email-pick="none"]')).not.toBeNull() })
    expect(draftRequests()).toBe(0)
    useAddress('privacy@example.org')
    await waitFor(() => { expect(bodyInput()?.value).toContain(DRAFT_PROSE) })
    expect(draftRequests()).toBe(1)
    // The page set no subject for this address: the model's is used.
    expect(host.emailDrafts[0]!.pageSubject).toBeNull()
    expect(subjectInput()?.value).toBe('Application for the analyst role')
  }, 15_000)

  it('by typing: one request', async () => {
    onCareersTab()
    host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
    render(<App />)
    await waitFor(() => { expect(status()).toBe('empty') }, { timeout: 8_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Type an Apply address' }))
    fireEvent.change(typedInput()!, { target: { value: 'hiring@example.org' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this address' }))
    await waitFor(() => { expect(bodyInput()?.value).toContain(DRAFT_PROSE) })
    expect(draftRequests()).toBe(1)
    expect(host.emailDrafts[0]!.pageSubject).toBeNull()
  }, 15_000)

  it('a second address typed into To after the Draft sends no second request', async () => {
    pickJobs()
    await scanEmailPage()
    await waitFor(() => { expect(bodyInput()).not.toBeNull() })
    const to = document.querySelector('[data-jff-email-to] input') as HTMLInputElement
    fireEvent.change(to, { target: { value: 'hr@example.org' } })
    fireEvent.blur(to)
    await waitFor(() => { expect(sessionRow()?.applyAddress).toBe('hr@example.org') })
    expect(draftRequests()).toBe(1)
  }, 15_000)
})

describe('a Session with no Job posting text', () => {
  it('asks for it and sends no request until text is pasted', async () => {
    await scanEmailPage({ jobText: false })
    await waitFor(() => { expect(document.querySelector('[data-jff-email-pick="none"]')).not.toBeNull() })
    useAddress('jobs@example.org')
    await waitFor(() => { expect(document.querySelector('[data-jff-email-needs-jobtext]')).not.toBeNull() })
    expect(draftRequests()).toBe(0)
    fireEvent.paste(pasteBox())
    fireEvent.change(pasteBox(), { target: { value: JOB_TEXT } })
    await waitFor(() => { expect(host.emailDrafts).toHaveLength(1) })
    expect(host.emailDrafts[0]!.jobText).toBe(JOB_TEXT)
    await waitFor(() => { expect(bodyInput()).not.toBeNull() })
    expect(document.querySelector('[data-jff-email-needs-jobtext]')).toBeNull()
  }, 15_000)

  it('sends no request while the text is typed, and one when it is picked on the page', async () => {
    await scanEmailPage({ jobText: false })
    await waitFor(() => { expect(document.querySelector('[data-jff-email-pick="none"]')).not.toBeNull() })
    useAddress('jobs@example.org')
    await waitFor(() => { expect(document.querySelector('[data-jff-email-needs-jobtext]')).not.toBeNull() })
    fireEvent.change(pasteBox(), { target: { value: 'Ac' } })
    expect(draftRequests()).toBe(0)
    host.pickText = JOB_TEXT
    fireEvent.click(screen.getByRole('button', { name: 'Pick job description' }))
    await waitFor(() => { expect(host.emailDrafts).toHaveLength(1) })
    expect(host.emailDrafts[0]!.jobText).toBe(JOB_TEXT)
  }, 15_000)
})

describe('Review of the Application email', () => {
  it('shows the To row, the subject, the body, the model and an attachment row naming the stored Resume', async () => {
    pickJobs()
    await scanEmailPage()
    await waitFor(() => { expect(bodyInput()).not.toBeNull() })
    expect((document.querySelector('[data-jff-email-to] input') as HTMLInputElement).value).toBe('jobs@example.org')
    const attachment = document.querySelector('[data-jff-email-attachment]')
    expect(attachment?.textContent).toContain('cv.txt')
    expect(attachment?.querySelector('input, button, textarea, select')).toBeNull()
    expect(document.querySelector('[data-jff-email-model]')?.textContent).toContain('claude-opus-5-5')
    expect(document.querySelector('[data-jff-email-review] [data-jff-draft-warning]')).toBeNull()
    expect(document.querySelector('[data-jff-email-unchecked]')).toBeNull()
  }, 15_000)

  it('flags the unsupported sentences, names a link the Profile does not hold, and warns on an unchecked Draft', async () => {
    pickJobs()
    host.emailDraft = (p) => ({
      ...draftReply(p),
      body: 'Hello,\n\nI led the payments team at Acme. I build analytical engines.\n\nBest regards,\nAda Lovelace',
      unsupportedClaims: ['I led the payments team at Acme.'],
      missingLinks: ['github'],
      unchecked: true,
    })
    await scanEmailPage()
    await waitFor(() => { expect(bodyInput()).not.toBeNull() })
    const warning = document.querySelector('[data-jff-email-review] [data-jff-draft-warning]')
    expect(warning?.textContent).toContain('I led the payments team at Acme.')
    expect(document.querySelector('[data-jff-email-missing-link="github"]')?.textContent).toMatch(/GitHub/)
    expect(document.querySelector('[data-jff-email-unchecked]')).not.toBeNull()
    await waitFor(() => { expect(sessionRow()?.emailDraft?.unchecked).toBe(true) })
    expect(sessionRow()?.emailDraft?.unsupportedClaims).toEqual(['I led the payments team at Acme.'])
    expect(sessionRow()?.emailDraft?.missingLinks).toEqual(['github'])
  }, 15_000)

  it('a hand edit to the body sets the edited mark, and survives a Side panel reload with no new Draft', async () => {
    pickJobs()
    const first = await scanEmailPage()
    await waitFor(() => { expect(bodyInput()).not.toBeNull() })
    expect(document.querySelector('[data-jff-email-edited]')).toBeNull()
    const edited = `${DRAFT_PROSE} I wrote this line myself.\n\nBest regards,\nAda Lovelace`
    fireEvent.change(bodyInput()!, { target: { value: edited } })
    expect(document.querySelector('[data-jff-email-edited]')).not.toBeNull()
    await waitFor(() => { expect(sessionRow()?.emailDraft?.edited).toBe(true) }, { timeout: 3_000 })
    expect(sessionRow()?.emailDraft?.body).toBe(edited)
    expect(sessionRow()?.emailDraft?.model).toBe('claude-opus-5-5')
    expect(sessionRow()?.emailDraft?.pageSubject).toBe('Application: Analyst')

    first.unmount()
    render(<App />)
    await waitFor(() => { expect(bodyInput()?.value).toBe(edited) }, { timeout: 8_000 })
    expect(document.querySelector('[data-jff-email-edited]')).not.toBeNull()
    expect(document.querySelector('[data-jff-email-model]')?.textContent).toContain('claude-opus-5-5')
    expect(draftRequests()).toBe(1)
  }, 20_000)

  it('an edit to the subject is kept and does not mark the body edited', async () => {
    pickJobs()
    await scanEmailPage()
    await waitFor(() => { expect(subjectInput()).not.toBeNull() })
    fireEvent.change(subjectInput()!, { target: { value: 'Application: Analyst, Ada Lovelace' } })
    await waitFor(() => { expect(sessionRow()?.emailDraft?.subject).toBe('Application: Analyst, Ada Lovelace') }, { timeout: 3_000 })
    expect(sessionRow()?.emailDraft?.edited).toBe(false)
  }, 15_000)

  it('a failed Draft says why and offers to try again', async () => {
    pickJobs()
    let calls = 0
    host.emailDraft = (p) => (++calls === 1 ? { error: { kind: 'timeout', message: 'claude timed out' } } : draftReply(p))
    await scanEmailPage()
    await waitFor(() => { expect(document.querySelector('[data-jff-email-draft="failed"]')).not.toBeNull() })
    expect(document.querySelector('[data-jff-email-draft="failed"]')?.textContent).toContain('claude timed out')
    expect(bodyInput()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => { expect(bodyInput()?.value).toContain(DRAFT_PROSE) })
    expect(draftRequests()).toBe(2)
  }, 15_000)
})

describe('the page subject for an address', () => {
  it('is the first non-empty subject among the links to it, in page order, case ignored', () => {
    const candidates = [
      { address: 'Jobs@Example.org', contexts: [
        { kind: 'text' as const, sentence: 'Write to jobs@example.org.' },
        { kind: 'mailto' as const, linkText: 'a', subject: null },
        { kind: 'mailto' as const, linkText: 'b', subject: '  ' },
        { kind: 'mailto' as const, linkText: 'c', subject: 'First' },
        { kind: 'mailto' as const, linkText: 'd', subject: 'Second' },
      ] },
    ]
    expect(pageSubjectFor(candidates, 'jobs@example.org')).toBe('First')
    expect(pageSubjectFor(candidates, 'other@example.org')).toBeNull()
  })
})
