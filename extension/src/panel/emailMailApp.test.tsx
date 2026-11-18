import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EmailDraftResult, FoundAddress, HostResponse } from '@jff/shared'
import { App } from './App'
import type { Session } from './sessions'
import { draftReply, installHeldMappingHost, status } from './testing/heldMapping'

/**
 * "Open in my mail app" (spec #66, ticket #75), at the panel seam: the whole
 * App against a fake Native host. Where Send will be, the Side panel offers a
 * `mailto:` address that carries the To row, the subject and the body, says
 * the Resume must be attached in the mail app, and leaves Mark applied to the
 * user. The mark then records the email as it was handed over.
 *
 * jsdom opens no address: a capture listener stands in for the browser. It
 * records the address a click on a `mailto:` link opens and stops jsdom's
 * navigation, without stopping the panel's own click handler.
 */

const host = installHeldMappingHost()

const PAGE: FoundAddress[] = [
  { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' } },
]
const JOB_TEXT = 'Acme is hiring an analyst to build analytical engines. '.repeat(10).trim()

let opened: string[]
let marks: Record<string, unknown>[]
const openMailto = (e: MouseEvent): void => {
  const a = (e.target as Element | null)?.closest('a[href^="mailto:"]')
  if (a === null || a === undefined) return
  e.preventDefault()
  opened.push(a.getAttribute('href')!)
}

beforeEach(() => {
  opened = []
  marks = []
  window.addEventListener('click', openMailto, true)
  const base = window.__jffHostBridge!
  window.__jffHostBridge = async (req): Promise<HostResponse> => {
    if (req.method === 'applied.check') return { requestId: req.requestId, ok: true, result: { applied: null } }
    if (req.method === 'applied.mark') {
      marks.push(req.params as Record<string, unknown>)
      return { requestId: req.requestId, ok: true, result: { id: 1, markedAt: '2026-11-18T12:00:00.000Z', channel: 'email' } }
    }
    return await base(req)
  }
})

afterEach(() => {
  window.removeEventListener('click', openMailto, true)
})

function onCareersTab(): void {
  const tab = { id: 7, url: 'https://careers.example.com/jobs/1', title: 'Analyst at Acme' }
  const chrome = (globalThis as unknown as { chrome: { tabs: { query: unknown; get: unknown } } }).chrome
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
}

const sessionRow = (): (Session & { mailHandover?: unknown }) | undefined =>
  host.storage['jff:session:7'] as (Session & { mailHandover?: unknown }) | undefined
const toInput = (): HTMLInputElement => document.querySelector('[data-jff-email-to] input') as HTMLInputElement
const subjectInput = (): HTMLInputElement => document.querySelector('[data-jff-email-subject] input') as HTMLInputElement
const bodyInput = (): HTMLTextAreaElement => document.querySelector('[data-jff-email-body] textarea') as HTMLTextAreaElement
const mailAppLink = (): HTMLAnchorElement | null => document.querySelector('a[data-jff-email-mailapp]')
const mailAppAction = (): HTMLElement | null => document.querySelector('[data-jff-email-mailapp]')

/** The page is scanned, the pick chooses jobs@example.org and the Draft is shown. */
async function draftShown(): Promise<void> {
  onCareersTab()
  host.addresses = PAGE
  host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
  host.addressPick = () => ({ position: 0 })
  render(<App />)
  await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
  await waitFor(() => { expect(bodyInput()).not.toBeNull() }, { timeout: 8_000 })
}

/**
 * Reads a `mailto:` address back as RFC 6068 defines it: the recipient before
 * the `?`, then `name=value` pairs, every part percent-decoded. A `+` is a
 * plus sign here, never a space. Line breaks travel as CRLF.
 */
function readMailto(href: string): { to: string; subject: string | null; body: string | null } {
  expect(href.startsWith('mailto:')).toBe(true)
  const rest = href.slice('mailto:'.length)
  const q = rest.indexOf('?')
  const fields: Record<string, string> = {}
  for (const pair of (q === -1 ? '' : rest.slice(q + 1)).split('&').filter((p) => p !== '')) {
    const eq = pair.indexOf('=')
    fields[decodeURIComponent(pair.slice(0, eq)).toLowerCase()] = decodeURIComponent(pair.slice(eq + 1))
  }
  const lf = (s: string | undefined): string | null => (s === undefined ? null : s.replace(/\r\n/g, '\n'))
  return { to: decodeURIComponent(q === -1 ? rest : rest.slice(0, q)), subject: lf(fields.subject), body: lf(fields.body) }
}

const SUBJECT = 'Candidatura: Analista de Motores — Ada Lovelace (São Paulo) + 100% remoto'
const BODY = 'Olá equipe,\n\nGostaria de me candidatar à vaga. Já construí motores analíticos & muito mais: 2 + 2 = 4?\n\nAtenciosamente,\nAda Lovelace'

describe('"Open in my mail app" hands the Application email to the mail app', () => {
  it('opens a mailto: address whose recipient, subject and body equal the rows, non-ASCII text and line breaks intact', async () => {
    await draftShown()
    fireEvent.change(toInput(), { target: { value: 'hiring@example.org' } })
    fireEvent.blur(toInput())
    fireEvent.change(subjectInput(), { target: { value: SUBJECT } })
    fireEvent.change(bodyInput(), { target: { value: BODY } })

    const link = mailAppLink()
    expect(link?.textContent).toBe('Open in my mail app')
    fireEvent.click(link!)
    expect(opened).toHaveLength(1)
    expect(readMailto(opened[0]!)).toEqual({ to: 'hiring@example.org', subject: SUBJECT, body: BODY })
  }, 20_000)

  it('names the Resume file to attach next to the action', async () => {
    await draftShown()
    const note = document.querySelector('[data-jff-email-mailapp-note]')
    expect(note?.textContent).toContain('cv.txt')
    expect(note?.textContent).toMatch(/attach/i)
  }, 20_000)

  it('is disabled while the Draft is being written and checked', async () => {
    onCareersTab()
    host.addresses = PAGE
    host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
    host.addressPick = () => ({ position: 0 })
    let release!: () => void
    host.emailDraft = (p) => {
      if (host.emailDrafts.length === 1) return draftReply(p)
      return new Promise<EmailDraftResult>((ok) => { release = () => ok(draftReply(p)) })
    }
    render(<App />)
    await waitFor(() => { expect(bodyInput()).not.toBeNull() }, { timeout: 8_000 })
    expect(mailAppLink()).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => { expect(document.querySelector('[data-jff-email-draft="redrafting"]')).not.toBeNull() })
    expect(mailAppLink()).toBeNull()
    expect((mailAppAction() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(mailAppAction()!)
    expect(opened).toEqual([])

    release()
    await waitFor(() => { expect(mailAppLink()).not.toBeNull() })
  }, 20_000)

  it.each([
    ['the subject', subjectInput],
    ['the body', bodyInput],
  ])('is disabled when %s is empty', async (_what, input) => {
    await draftShown()
    fireEvent.change(input(), { target: { value: '   ' } })
    expect(mailAppLink()).toBeNull()
    expect((mailAppAction() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(mailAppAction()!)
    expect(opened).toEqual([])
  }, 20_000)
})

describe('after "Open in my mail app", Mark applied is the user\'s click', () => {
  it('marks nothing until Mark applied is clicked', async () => {
    await draftShown()
    fireEvent.click(mailAppLink()!)
    await waitFor(() => { expect(sessionRow()?.mailHandover).toBeTruthy() }, { timeout: 3_000 })
    expect(document.querySelector('[data-jff-email-handed]')?.textContent).toMatch(/Mark applied/)
    expect(host.methods).not.toContain('applied.mark')
    expect(marks).toEqual([])
  }, 20_000)

  it('records the channel email and the email as handed over, even when the rows were edited afterwards', async () => {
    await draftShown()
    fireEvent.change(bodyInput(), { target: { value: BODY } })
    fireEvent.click(mailAppLink()!)
    // Edits after the handover change what the panel shows, not what left.
    fireEvent.change(subjectInput(), { target: { value: 'A subject written later' } })
    fireEvent.change(bodyInput(), { target: { value: 'A body written later.' } })
    fireEvent.change(toInput(), { target: { value: 'later@example.org' } })
    fireEvent.blur(toInput())

    fireEvent.click(document.querySelector('[data-jff-mark-applied]')!)
    await waitFor(() => { expect(marks).toHaveLength(1) })
    expect(marks[0]).toMatchObject({ url: 'https://careers.example.com/jobs/1', channel: 'email' })
    expect(marks[0]!.email).toEqual({
      applyAddress: 'jobs@example.org',
      subject: 'Application: Analyst',
      body: BODY,
      language: 'en',
      aiDrafted: true,
      edited: true,
      model: 'claude-opus-5-5',
    })
    // The mark ends the Session as Mark applied does today.
    await waitFor(() => { expect(sessionRow()).toBeUndefined() })
  }, 20_000)

  it('records an unedited body as not edited', async () => {
    await draftShown()
    fireEvent.click(mailAppLink()!)
    fireEvent.click(document.querySelector('[data-jff-mark-applied]')!)
    await waitFor(() => { expect(marks).toHaveLength(1) })
    expect(marks[0]!.email).toMatchObject({ edited: false, aiDrafted: true, body: draftReply({ jobText: '', company: null, title: null, pageSubject: null }).body })
  }, 20_000)

  it('carries no Application email on a mark when the mail app was never opened', async () => {
    await draftShown()
    fireEvent.click(document.querySelector('[data-jff-mark-applied]')!)
    await waitFor(() => { expect(marks).toHaveLength(1) })
    expect(marks[0]!.email).toBeUndefined()
  }, 20_000)
})
