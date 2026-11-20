import { describe, it, expect } from 'vitest'
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import { EMAIL_INSTRUCTION_MAX, type EmailDraftParams, type EmailDraftResult, type FoundAddress } from '@jff/shared'
import { App } from './App'
import type { Session } from './sessions'
import { DRAFT_PROSE, draftReply, installHeldMappingHost, status } from './testing/heldMapping'

/**
 * Regenerate and the Application email's language in the Side panel (spec
 * #66, ticket #73). Review offers a new Draft, with an instruction when the
 * user types one, and a switch between English and Portuguese that writes one
 * in the other language. Over hand edits both ask first. The App renders
 * against a fake Native host.
 */

const host = installHeldMappingHost()

const PAGE: FoundAddress[] = [
  { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' } },
  { address: 'hr@example.org', context: { kind: 'text', sentence: 'Questions about the role go to hr@example.org.' } },
]
const JOB_TEXT = 'Acme is hiring an analyst to build analytical engines. '.repeat(10).trim()
const NEW_PROSE = 'Hello,\n\nA second Draft, shorter.'
const PT_PROSE = 'Olá,\n\nGostaria de me candidatar à vaga de analista.'

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
const regenerateRow = (): HTMLElement => document.querySelector('[data-jff-email-regenerate]') as HTMLElement
const instructionInput = (): HTMLInputElement => within(regenerateRow()).getByRole('textbox') as HTMLInputElement
const languageButton = (name: 'English' | 'Portuguese'): HTMLButtonElement =>
  within(within(regenerateRow()).getByRole('group', { name: 'Language' })).getByRole('button', { name }) as HTMLButtonElement
const regenerate = (): void => { fireEvent.click(within(regenerateRow()).getByRole('button', { name: 'Regenerate' })) }
const confirmBox = (): HTMLElement | null => document.querySelector('[data-jff-email-confirm]')

/**
 * The fake host's Drafts, one per request in order: the first is the usual
 * one, the later ones each write a different prose and a different model
 * subject, in the language asked for.
 */
function draftsInTurn(): void {
  host.emailDraft = (p: EmailDraftParams): EmailDraftResult => {
    const n = host.emailDrafts.length
    if (n === 1) return draftReply(p)
    const prose = p.language === 'pt' ? PT_PROSE : NEW_PROSE
    const signOff = p.language === 'pt' ? 'Atenciosamente,' : 'Best regards,'
    return {
      ...draftReply(p),
      subject: p.pageSubject ?? `Model subject ${n}`,
      body: `${prose}\n\n${signOff}\nAda Lovelace`,
      model: 'claude-sonnet-5-5',
    }
  }
}

/** A Scan of the page, the pick on `address`, and the first Draft shown. */
async function firstDraft(address = 'jobs@example.org'): Promise<ReturnType<typeof render>> {
  onCareersTab()
  host.addresses = PAGE
  host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
  host.addressPick = (p) => ({ position: p.candidates.findIndex((c) => c.address === address) })
  draftsInTurn()
  const out = render(<App />)
  await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
  await waitFor(() => { expect(bodyInput()?.value).toContain(DRAFT_PROSE) }, { timeout: 8_000 })
  return out
}

describe('Regenerate', () => {
  it('sends a Draft request, and the new prose replaces the old with the model that wrote it', async () => {
    await firstDraft()
    regenerate()
    await waitFor(() => { expect(bodyInput()?.value).toContain(NEW_PROSE) })
    expect(bodyInput()?.value).not.toContain(DRAFT_PROSE)
    expect(draftRequests()).toBe(2)
    const sent = host.emailDrafts[1]!
    expect(sent.jobText).toBe(JOB_TEXT)
    expect(sent.language).toBe('en')
    expect(sent.instruction).toBeUndefined()
    expect(confirmBox()).toBeNull()
    await waitFor(() => { expect(sessionRow()?.emailDraft?.body).toContain(NEW_PROSE) })
    expect(sessionRow()?.emailDraft?.model).toBe('claude-sonnet-5-5')
  }, 15_000)

  it('carries the instruction the user typed, and the box takes no more than the cap', async () => {
    await firstDraft()
    expect(instructionInput().maxLength).toBe(EMAIL_INSTRUCTION_MAX)
    fireEvent.change(instructionInput(), { target: { value: 'Lead with the payments work.' } })
    regenerate()
    await waitFor(() => { expect(host.emailDrafts).toHaveLength(2) })
    expect(host.emailDrafts[1]!.instruction).toBe('Lead with the payments work.')

    fireEvent.change(instructionInput(), { target: { value: 'y'.repeat(EMAIL_INSTRUCTION_MAX + 50) } })
    expect(instructionInput().value).toHaveLength(EMAIL_INSTRUCTION_MAX)
  }, 15_000)

  it('rewrites a subject the model wrote and nobody edited', async () => {
    await firstDraft('hr@example.org')
    expect(subjectInput()?.value).toBe('Application for the analyst role')
    regenerate()
    await waitFor(() => { expect(subjectInput()?.value).toBe('Model subject 2') })
  }, 15_000)

  it('keeps a page subject unchanged', async () => {
    await firstDraft()
    expect(subjectInput()?.value).toBe('Application: Analyst')
    regenerate()
    await waitFor(() => { expect(bodyInput()?.value).toContain(NEW_PROSE) })
    expect(host.emailDrafts[1]!.pageSubject).toBe('Application: Analyst')
    expect(subjectInput()?.value).toBe('Application: Analyst')
  }, 15_000)
})

describe('the language switch', () => {
  it('shows the language in use, and switching sends a Draft request for the other one', async () => {
    await firstDraft()
    expect(languageButton('English').getAttribute('aria-pressed')).toBe('true')
    expect(languageButton('Portuguese').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(languageButton('Portuguese'))
    await waitFor(() => { expect(bodyInput()?.value).toContain(PT_PROSE) })
    expect(host.emailDrafts[1]!.language).toBe('pt')
    expect(languageButton('Portuguese').getAttribute('aria-pressed')).toBe('true')
    expect(languageButton('English').getAttribute('aria-pressed')).toBe('false')
    // A click on the language in use asks for nothing.
    fireEvent.click(languageButton('Portuguese'))
    expect(draftRequests()).toBe(2)
  }, 15_000)

  it('keeps a page subject unchanged', async () => {
    await firstDraft()
    fireEvent.click(languageButton('Portuguese'))
    await waitFor(() => { expect(bodyInput()?.value).toContain(PT_PROSE) })
    expect(subjectInput()?.value).toBe('Application: Analyst')
  }, 15_000)

  it('Regenerate after a switch keeps the language switched to', async () => {
    await firstDraft()
    fireEvent.click(languageButton('Portuguese'))
    await waitFor(() => { expect(bodyInput()?.value).toContain(PT_PROSE) })
    regenerate()
    await waitFor(() => { expect(host.emailDrafts).toHaveLength(3) })
    expect(host.emailDrafts[2]!.language).toBe('pt')
  }, 15_000)

  it('is still set after a Side panel reload', async () => {
    const first = await firstDraft()
    fireEvent.click(languageButton('Portuguese'))
    await waitFor(() => { expect(sessionRow()?.emailDraft?.language).toBe('pt') }, { timeout: 3_000 })
    first.unmount()
    render(<App />)
    await waitFor(() => { expect(bodyInput()?.value).toContain(PT_PROSE) }, { timeout: 8_000 })
    expect(languageButton('Portuguese').getAttribute('aria-pressed')).toBe('true')
    expect(draftRequests()).toBe(2)
  }, 20_000)
})

describe('over hand edits', () => {
  const EDITED = `${DRAFT_PROSE} I wrote this line myself.\n\nBest regards,\nAda Lovelace`

  it.each([
    ['Regenerate', regenerate],
    ['the switch', () => { fireEvent.click(languageButton('Portuguese')) }],
  ])('%s asks first, and declining keeps the edit and sends nothing', async (_name, act) => {
    await firstDraft()
    fireEvent.change(bodyInput()!, { target: { value: EDITED } })
    act()
    await waitFor(() => { expect(confirmBox()).not.toBeNull() })
    expect(confirmBox()?.textContent).toContain('replaces your edits to the body')
    expect(draftRequests()).toBe(1)
    fireEvent.click(within(confirmBox()!).getByRole('button', { name: 'Keep my edits' }))
    expect(confirmBox()).toBeNull()
    expect(bodyInput()?.value).toBe(EDITED)
    await waitFor(() => { expect(sessionRow()?.emailDraft?.edited).toBe(true) }, { timeout: 3_000 })
    expect(sessionRow()?.emailDraft?.body).toBe(EDITED)
    expect(draftRequests()).toBe(1)
  }, 15_000)

  it('confirming sends the request and replaces the edited body, which is no longer marked edited', async () => {
    await firstDraft()
    fireEvent.change(bodyInput()!, { target: { value: EDITED } })
    regenerate()
    await waitFor(() => { expect(confirmBox()).not.toBeNull() })
    fireEvent.click(within(confirmBox()!).getByRole('button', { name: 'Write a new Draft' }))
    await waitFor(() => { expect(bodyInput()?.value).toContain(NEW_PROSE) })
    expect(draftRequests()).toBe(2)
    expect(document.querySelector('[data-jff-email-edited]')).toBeNull()
  }, 15_000)

  it('an edited subject asks first too, and stays through the new Draft', async () => {
    await firstDraft('hr@example.org')
    fireEvent.change(subjectInput()!, { target: { value: 'Analyst application, Ada Lovelace' } })
    regenerate()
    await waitFor(() => { expect(confirmBox()).not.toBeNull() })
    expect(confirmBox()?.textContent).toContain('Your edited subject stays.')
    fireEvent.click(within(confirmBox()!).getByRole('button', { name: 'Write a new Draft' }))
    await waitFor(() => { expect(bodyInput()?.value).toContain(NEW_PROSE) })
    expect(subjectInput()?.value).toBe('Analyst application, Ada Lovelace')
  }, 15_000)
})

describe('a failed new Draft', () => {
  it('says why and leaves the Draft as it was', async () => {
    await firstDraft()
    host.emailDraft = () => ({ error: { kind: 'timeout', message: 'claude timed out' } })
    regenerate()
    await waitFor(() => { expect(within(regenerateRow()).getByRole('alert').textContent).toContain('claude timed out') })
    expect(bodyInput()?.value).toContain(DRAFT_PROSE)
    expect(languageButton('English').getAttribute('aria-pressed')).toBe('true')
  }, 15_000)
})
