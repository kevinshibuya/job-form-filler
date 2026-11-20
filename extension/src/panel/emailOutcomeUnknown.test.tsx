import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FoundAddress, MailSendResult, MailSendersResult, MailStatus } from '@jff/shared'
import { App } from './App'
import type { Session } from './sessions'
import { installHeldMappingHost, SENT, status, type AppliedCheckJob, type MailSendAnswer } from './testing/heldMapping'

/**
 * A Send whose outcome is unknown (spec #66, ticket #83), at the panel seam:
 * the whole App on the fake host port. When the Native host answers
 * "outcome unknown", or the request dies on the way, the Draft stays and the
 * Side panel asks one question with two actions: "It arrived" marks the Job
 * posting applied by email, and "Send again" abandons the old attempt and
 * sends once more. The panel says the user chose to send again only after
 * "Send again" or when the Session's `revisitPassed` is set.
 */

const host = installHeldMappingHost()

const URL_OF_TAB = 'https://careers.example.com/jobs/1'
const PAGE: FoundAddress[] = [
  { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' } },
]
const JOB_TEXT = 'Acme is hiring an analyst to build analytical engines. '.repeat(10).trim()
const CONNECTED: MailStatus = { state: 'connected', kind: 'gmail', address: 'ada@example.com', connectedAt: '2026-11-19T12:00:00.000Z' }
const SENDERS: MailSendersResult = {
  address: 'ada@example.com',
  senders: [{ address: 'ada@example.com', displayName: 'Ada Lovelace' }],
  lastUsed: null,
}
const UNKNOWN = (attemptRequestId: string): MailSendResult => ({ outcome: 'unknown', attemptRequestId })

/** The Applied job a first Send of this page left behind. */
const APPLIED: AppliedCheckJob = {
  id: 1, url: URL_OF_TAB, canonicalUrl: 'careers.example.com/jobs/1',
  company: 'Acme', jobTitle: 'Analyst at Acme', markedAt: '2026-11-19T12:00:00.000Z', channel: 'email',
}

beforeEach(() => {
  const tab = { id: 7, url: URL_OF_TAB, title: 'Analyst at Acme', active: true, windowId: 1 }
  const chrome = (globalThis as unknown as { chrome: { tabs: { query: unknown; get: unknown } } }).chrome
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
  host.addresses = PAGE
  host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
  host.addressPick = () => ({ position: 0 })
  host.mailStatus = () => CONNECTED
  host.mailSenders = () => SENDERS
})

const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined
const bodyInput = (): HTMLTextAreaElement | null => document.querySelector('[data-jff-email-body] textarea')
const sendButton = (): HTMLButtonElement | null => document.querySelector('button[data-jff-email-sendmail]')
const prompt = (): HTMLElement | null => document.querySelector('[data-jff-send-unknown]')
const sendError = (): HTMLElement | null => document.querySelector('[data-jff-email-send-error]')

async function sendShown(): Promise<HTMLButtonElement> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
  await waitFor(() => { expect(sendButton()).not.toBeNull() }, { timeout: 8_000 })
  return sendButton()!
}

/** One click on Send, answered "outcome unknown" for the attempt the host names. */
async function unknownShown(attempt = 'ATTEMPT_1'): Promise<void> {
  host.mailSend = () => UNKNOWN(attempt)
  const button = await sendShown()
  fireEvent.change(bodyInput()!, { target: { value: 'My own words.\n\nAda Lovelace' } })
  fireEvent.click(button)
  await waitFor(() => { expect(prompt()).not.toBeNull() })
}

describe('"outcome unknown"', () => {
  it('keeps the Draft and shows both actions with the advice to check the Sent folder', async () => {
    await unknownShown()
    expect(prompt()!.textContent).toMatch(/Sent folder/)
    expect(within(prompt()!).getByRole('button', { name: 'It arrived' })).toBeTruthy()
    expect(within(prompt()!).getByRole('button', { name: 'Send again' })).toBeTruthy()
    expect(sessionRow()).toBeDefined()
    expect(bodyInput()!.value).toBe('My own words.\n\nAda Lovelace')
    expect(document.querySelector('[data-jff-applied]')).toBeNull()
    expect(sendError()).toBeNull()
    // The doubt is settled by one of the two actions, not by Send.
    expect(sendButton()!.disabled).toBe(true)
    expect(host.mailSends).toHaveLength(1)
  }, 20_000)

  it('shows the same question when the request dies on the way, for the attempt the panel sent', async () => {
    host.mailSend = (): MailSendAnswer => ({ error: { kind: 'unreachable', message: 'Native host disconnected' } })
    const button = await sendShown()
    fireEvent.click(button)
    await waitFor(() => { expect(prompt()).not.toBeNull() })
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Send again' }))
    await waitFor(() => { expect(host.mailSends).toHaveLength(2) })
    expect(host.mailSends[1]!.abandonAttempt).toBe(host.mailSendIds[0])
  }, 20_000)

  it('"It arrived" sends mail.send.arrived for that attempt with the email as shown, and ends the Session', async () => {
    await unknownShown('ATTEMPT_7')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'It arrived' }))
    await waitFor(() => { expect(host.mailArrivals).toHaveLength(1) })
    expect(host.mailArrivals[0]).toEqual({
      attemptRequestId: 'ATTEMPT_7',
      url: URL_OF_TAB,
      company: 'Acme',
      jobTitle: 'Analyst at Acme',
      applyAddress: 'jobs@example.org',
      senderAddress: 'ada@example.com',
      subject: 'Application: Analyst',
      body: 'My own words.\n\nAda Lovelace',
      language: 'en',
      attachmentNames: ['cv.txt'],
      aiDrafted: true,
      edited: true,
      model: host.mailSends[0]!.model,
    })
    await waitFor(() => { expect(sessionRow()).toBeUndefined() })
    await waitFor(() => { expect(document.querySelector('[data-jff-applied]')?.textContent).toMatch(/Marked as applied/) })
    expect(host.mailSends).toHaveLength(1)
  }, 20_000)

  it('"Send again" abandons the old attempt and sends once more, with the choice set', async () => {
    await unknownShown('ATTEMPT_7')
    host.mailSend = () => SENT
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Send again' }))
    await waitFor(() => { expect(host.mailSends).toHaveLength(2) })
    expect(host.mailSends[1]).toMatchObject({ resend: true, abandonAttempt: 'ATTEMPT_7', body: 'My own words.\n\nAda Lovelace' })
    await waitFor(() => { expect(sessionRow()).toBeUndefined() })
  }, 20_000)
})

describe('the choice to send again', () => {
  it('is not set on a first Send', async () => {
    const button = await sendShown()
    fireEvent.click(button)
    await waitFor(() => { expect(host.mailSends).toHaveLength(1) })
    expect(host.mailSends[0]).toMatchObject({ resend: false, abandonAttempt: null })
  }, 20_000)

  it('is set once the user passed the Revisit badge by Canonical URL, so a second Send from the same page goes out', async () => {
    host.appliedCheck = () => ({ applied: APPLIED, appliedByAddress: null })
    render(<App />)
    await waitFor(() => { expect(document.querySelector('[data-jff-applied]')).not.toBeNull() }, { timeout: 8_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Scan anyway' }))
    await waitFor(() => { expect(sessionRow()?.revisitPassed).toBe(true) })
    await waitFor(() => { expect(sendButton()).not.toBeNull() }, { timeout: 8_000 })
    fireEvent.click(sendButton()!)
    await waitFor(() => { expect(host.mailSends).toHaveLength(1) })
    expect(host.mailSends[0]).toMatchObject({ resend: true, abandonAttempt: null })
    await waitFor(() => { expect(sessionRow()).toBeUndefined() })
  }, 20_000)

  /** Past the Canonical URL badge, with the Send button shown. */
  async function passedRevisit(): Promise<ReturnType<typeof render>> {
    host.appliedCheck = () => ({ applied: APPLIED, appliedByAddress: null })
    const view = render(<App />)
    await waitFor(() => { expect(document.querySelector('[data-jff-applied]')).not.toBeNull() }, { timeout: 8_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Scan anyway' }))
    await waitFor(() => { expect(sessionRow()?.revisitPassed).toBe(true) })
    await waitFor(() => { expect(sendButton()).not.toBeNull() }, { timeout: 8_000 })
    return view
  }

  it('is spent by a Send the Session issued: a panel that died mid-Send and came back sends without it', async () => {
    // The host may have recorded that Send as sent; only its "already sent"
    // refusal stands between a second click and a second email.
    host.mailSend = () => new Promise<MailSendAnswer>(() => {})
    const first = await passedRevisit()
    fireEvent.click(sendButton()!)
    await waitFor(() => { expect(host.mailSends).toHaveLength(1) })
    expect(host.mailSends[0]).toMatchObject({ resend: true, abandonAttempt: null })
    await waitFor(() => { expect(sessionRow()?.sendIssued).toBe(true) })
    first.unmount()

    host.mailSend = () => SENT
    render(<App />)
    await waitFor(() => { expect(sendButton()?.disabled).toBe(false) }, { timeout: 8_000 })
    fireEvent.click(sendButton()!)
    await waitFor(() => { expect(host.mailSends).toHaveLength(2) })
    expect(host.mailSends[1]).toMatchObject({ resend: false, abandonAttempt: null })
  }, 30_000)

  it('comes back after a failure Gmail states, so the next Send still goes past the earlier Applied job', async () => {
    host.mailSend = () => ({ error: { kind: 'process', message: 'Gmail refused the Application email (400). Nothing was sent.' } })
    await passedRevisit()
    fireEvent.click(sendButton()!)
    await waitFor(() => { expect(sendError()).not.toBeNull() })
    await waitFor(() => { expect(sessionRow()?.sendIssued).toBe(false) })
    host.mailSend = () => SENT
    fireEvent.click(sendButton()!)
    await waitFor(() => { expect(host.mailSends).toHaveLength(2) })
    expect(host.mailSends[1]).toMatchObject({ resend: true, abandonAttempt: null })
  }, 30_000)

  it('stays spent after the host\'s "already sent" refusal', async () => {
    host.mailSend = () => ({ error: { kind: 'bad_request', message: 'An Application email to jobs@example.org for this Job posting was already sent. Nothing was sent again.' } })
    await passedRevisit()
    fireEvent.click(sendButton()!)
    await waitFor(() => { expect(sendError()).not.toBeNull() })
    await waitFor(() => { expect(sessionRow()?.sendIssued).toBe(true) })
    fireEvent.click(sendButton()!)
    await waitFor(() => { expect(host.mailSends).toHaveLength(2) })
    expect(host.mailSends[1]).toMatchObject({ resend: false, abandonAttempt: null })
  }, 30_000)
})

describe('a failure Gmail states', () => {
  it('shows no question and leaves Send for another click', async () => {
    host.mailSend = () => ({ error: { kind: 'process', message: 'Gmail refused the Application email (400). Nothing was sent.' } })
    const button = await sendShown()
    fireEvent.click(button)
    await waitFor(() => { expect(sendError()).not.toBeNull() })
    expect(prompt()).toBeNull()
    expect(sendButton()!.disabled).toBe(false)
    host.mailSend = () => SENT
    fireEvent.click(sendButton()!)
    await waitFor(() => { expect(host.mailSends).toHaveLength(2) })
    expect(host.mailSends[1]).toMatchObject({ resend: false, abandonAttempt: null })
  }, 20_000)
})
