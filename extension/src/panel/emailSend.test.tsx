import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EmailDraftResult, FoundAddress, MailSendResult, MailSendersResult, MailStatus } from '@jff/shared'
import { App } from './App'
import type { Session } from './sessions'
import { draftReply, installHeldMappingHost, SENT, status, type MailSendAnswer } from './testing/heldMapping'

/**
 * Send (spec #66, ticket #82), at the panel seam: the whole App against a
 * fake Native host. With a connected Mail account the email Review shows one
 * button that names both addresses. One click sends `mail.send` with
 * everything the Send needs, the Resume file included, and no dialog comes
 * between. A Send that went out ends the Session as Mark applied does; one
 * that failed leaves the Draft in place for another click.
 */

const host = installHeldMappingHost()

const PAGE: FoundAddress[] = [
  { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' } },
]
const JOB_TEXT = 'Acme is hiring an analyst to build analytical engines. '.repeat(10).trim()
const CONNECTED: MailStatus = { state: 'connected', kind: 'gmail', address: 'ada@example.com', connectedAt: '2026-11-19T12:00:00.000Z' }
const SENDERS: MailSendersResult = {
  address: 'ada@example.com',
  senders: [
    { address: 'ada@example.com', displayName: 'Ada Lovelace' },
    { address: 'ada@work.example.com', displayName: 'Ada at Work' },
  ],
  lastUsed: null,
}

beforeEach(() => {
  const tab = { id: 7, url: 'https://careers.example.com/jobs/1', title: 'Analyst at Acme', active: true, windowId: 1 }
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
const toInput = (): HTMLInputElement => document.querySelector('[data-jff-email-to] input') as HTMLInputElement
const subjectInput = (): HTMLInputElement => document.querySelector('[data-jff-email-subject] input') as HTMLInputElement
const bodyInput = (): HTMLTextAreaElement | null => document.querySelector('[data-jff-email-body] textarea')
const sendButton = (): HTMLButtonElement | null => document.querySelector('button[data-jff-email-sendmail]')
const senderSelect = (): HTMLSelectElement | null => document.querySelector('[data-jff-email-sender] select')
const sendError = (): HTMLElement | null => document.querySelector('[data-jff-email-send-error]')

async function draftShown(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
  await waitFor(() => { expect(bodyInput()).not.toBeNull() }, { timeout: 8_000 })
}

async function sendShown(): Promise<HTMLButtonElement> {
  await draftShown()
  await waitFor(() => { expect(sendButton()).not.toBeNull() })
  return sendButton()!
}

const base64 = (text: string): string => btoa(text)

describe('the Send button', () => {
  it('names both addresses, and follows the Sender address row', async () => {
    const button = await sendShown()
    expect(button.textContent).toBe('Send from ada@example.com to jobs@example.org')
    expect(button.disabled).toBe(false)

    fireEvent.change(senderSelect()!, { target: { value: 'ada@work.example.com' } })
    await waitFor(() => { expect(sendButton()!.textContent).toBe('Send from ada@work.example.com to jobs@example.org') })

    fireEvent.change(toInput(), { target: { value: 'hiring@example.org' } })
    fireEvent.blur(toInput())
    await waitFor(() => { expect(sendButton()!.textContent).toBe('Send from ada@work.example.com to hiring@example.org') })
  }, 20_000)

  it('is not offered without a connected Mail account', async () => {
    host.mailStatus = () => ({ state: 'none' })
    await draftShown()
    await waitFor(() => { expect(document.querySelector('[data-jff-email-connect]')).not.toBeNull() })
    expect(sendButton()).toBeNull()
  }, 20_000)

  it('is not offered when the sign-in died: Reconnect stands there', async () => {
    host.mailStatus = () => ({ ...CONNECTED, state: 'needs_reconnect' })
    await draftShown()
    await waitFor(() => { expect(document.querySelector('[data-jff-email-reconnect]')).not.toBeNull() })
    expect(sendButton()).toBeNull()
  }, 20_000)

  it('is disabled while the Draft is being written and checked', async () => {
    let release!: () => void
    host.emailDraft = (p) => {
      if (host.emailDrafts.length === 1) return draftReply(p)
      return new Promise<EmailDraftResult>((ok) => { release = () => ok(draftReply(p)) })
    }
    await sendShown()
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => { expect(document.querySelector('[data-jff-email-draft="redrafting"]')).not.toBeNull() })
    expect(sendButton()!.disabled).toBe(true)
    fireEvent.click(sendButton()!)
    expect(host.mailSends).toEqual([])

    release()
    await waitFor(() => { expect(sendButton()!.disabled).toBe(false) })
  }, 20_000)

  it.each([
    ['the To address', toInput],
    ['the subject', subjectInput],
    ['the body', () => bodyInput()!],
  ])('is disabled when %s is empty', async (_what, input) => {
    await sendShown()
    fireEvent.change(input(), { target: { value: '  ' } })
    fireEvent.blur(input())
    await waitFor(() => { expect(sendButton()?.disabled ?? true).toBe(true) })
    if (sendButton() !== null) fireEvent.click(sendButton()!)
    expect(host.mailSends).toEqual([])
  }, 20_000)

  it('is disabled while a Send is in flight, so a second click sends nothing', async () => {
    let release!: (a: MailSendAnswer) => void
    host.mailSend = () => new Promise<MailSendAnswer>((ok) => { release = ok })
    const button = await sendShown()
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => { expect(host.mailSends).toHaveLength(1) })
    await waitFor(() => { expect(sendButton()?.disabled).toBe(true) })
    fireEvent.click(sendButton()!)
    expect(host.mailSends).toHaveLength(1)
    expect(document.querySelector('[data-jff-email-sending]')).not.toBeNull()
    release({ error: { kind: 'process', message: 'Gmail refused the Application email (400). Nothing was sent.' } })
    await waitFor(() => { expect(sendButton()?.disabled).toBe(false) })
  }, 20_000)
})

describe('one click', () => {
  it('sends mail.send at once, with no dialog, carrying everything the Send needs', async () => {
    const button = await sendShown()
    fireEvent.change(bodyInput()!, { target: { value: 'Hello,\n\nI apply — with my Résumé.\n\nAda Lovelace' } })
    expect(host.methods).not.toContain('mail.send')

    fireEvent.click(button)
    expect(document.querySelector('[role="dialog"], [role="alertdialog"], dialog')).toBeNull()
    await waitFor(() => { expect(host.mailSends).toHaveLength(1) })
    expect(host.mailSends[0]).toEqual({
      url: 'https://careers.example.com/jobs/1',
      company: 'Acme',
      jobTitle: 'Analyst at Acme',
      applyAddress: 'jobs@example.org',
      senderAddress: 'ada@example.com',
      subject: 'Application: Analyst',
      body: 'Hello,\n\nI apply — with my Résumé.\n\nAda Lovelace',
      language: 'en',
      resume: { name: 'cv.txt', mimeType: 'text/plain', dataBase64: base64('stub resume') },
      aiDrafted: true,
      edited: true,
      model: draftReply({ jobText: JOB_TEXT, company: null, title: null, pageSubject: null }).model,
    })
  }, 20_000)

  it('carries the Sender address the row shows', async () => {
    host.mailSenders = () => ({ ...SENDERS, lastUsed: 'ada@work.example.com' })
    await sendShown()
    await waitFor(() => { expect(sendButton()!.textContent).toContain('ada@work.example.com') })
    fireEvent.click(sendButton()!)
    await waitFor(() => { expect(host.mailSends).toHaveLength(1) })
    expect(host.mailSends[0]!.senderAddress).toBe('ada@work.example.com')
    expect(host.mailSends[0]!.edited).toBe(false)
  }, 20_000)

  it('that went out ends the Session, and the Job posting shows as applied', async () => {
    host.mailSend = (): MailSendResult => SENT
    const button = await sendShown()
    expect(sessionRow()).toBeDefined()
    fireEvent.click(button)
    await waitFor(() => { expect(sessionRow()).toBeUndefined() })
    await waitFor(() => { expect(document.querySelector('[data-jff-applied]')?.textContent).toMatch(/Marked as applied/) })
    expect(bodyInput()).toBeNull()
    // The host's Send marked it: the panel sends no mark of its own.
    expect(host.methods).not.toContain('applied.mark')
  }, 20_000)

  it('that failed leaves the Draft in place with the reason, and a second click sends', async () => {
    host.mailSend = () => ({ error: { kind: 'process', message: 'Gmail refused the Application email (400: Recipient address required). Nothing was sent.' } })
    const button = await sendShown()
    fireEvent.change(bodyInput()!, { target: { value: 'My own words.' } })
    fireEvent.click(button)
    await waitFor(() => { expect(sendError()?.textContent).toContain('Recipient address required') })
    expect(sessionRow()).toBeDefined()
    expect(bodyInput()!.value).toBe('My own words.')
    expect(document.querySelector('[data-jff-applied]')).toBeNull()

    host.mailSend = () => SENT
    fireEvent.click(sendButton()!)
    await waitFor(() => { expect(host.mailSends).toHaveLength(2) })
    await waitFor(() => { expect(sessionRow()).toBeUndefined() })
  }, 20_000)
})

describe('nothing but the click sends', () => {
  it('a Draft written, edited, regenerated and handed to the mail app sends no mail.send', async () => {
    await sendShown()
    fireEvent.change(bodyInput()!, { target: { value: 'Edited.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => { expect(document.querySelector('[data-jff-email-confirm]')).not.toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'Write a new Draft' }))
    await waitFor(() => { expect(host.emailDrafts).toHaveLength(2) })
    await waitFor(() => { expect(sendButton()?.disabled).toBe(false) })
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => { expect(host.methods.filter((m) => m === 'mail.status').length).toBeGreaterThan(1) })
    expect(host.mailSends).toEqual([])
    expect(host.methods).not.toContain('mail.send')
  }, 20_000)
})
