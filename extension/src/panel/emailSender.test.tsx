import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import type { FoundAddress, MailSendersResult, MailStatus } from '@jff/shared'
import { App } from './App'
import type { Session } from './sessions'
import { installHeldMappingHost, status, type MailSendersAnswer } from './testing/heldMapping'

/**
 * The Sender address row and Reconnect in the email Review (spec #66, ticket
 * #81), at the panel seam: the whole App against a fake Native host. With a
 * connected Mail account the Review asks `mail.senders` and shows the Sender
 * address row: a dropdown when the account may send as more than one
 * address, the address alone otherwise. When the sign-in died, Reconnect
 * stands where Send will be, and the Draft and its edits stay as they are.
 */

const host = installHeldMappingHost()

const EXT = 'chrome-extension://jffextensionid/'
const SETTINGS = `${EXT}src/settings/index.html`
const PAGE: FoundAddress[] = [
  { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' } },
]
const JOB_TEXT = 'Acme is hiring an analyst to build analytical engines. '.repeat(10).trim()
const CONNECTED: MailStatus = { state: 'connected', kind: 'gmail', address: 'ada@example.com', connectedAt: '2026-11-19T12:00:00.000Z' }
const DIED: MailStatus = { ...CONNECTED, state: 'needs_reconnect' }
const SENDERS: MailSendersResult = {
  address: 'ada@example.com',
  senders: [
    { address: 'ada@example.com', displayName: 'Ada Lovelace' },
    { address: 'ada@work.example.com', displayName: 'Ada at Work' },
  ],
  lastUsed: null,
}

interface FakeTab { id: number; url: string; title: string; active: boolean; windowId: number }
let tabs: FakeTab[]
let created: string[]

beforeEach(() => {
  tabs = [{ id: 7, url: 'https://careers.example.com/jobs/1', title: 'Analyst at Acme', active: true, windowId: 1 }]
  created = []
  const chrome = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome
  chrome.runtime!.getURL = (path: string) => `${EXT}${path.replace(/^\//, '')}`
  chrome.tabs!.query = async (q: { active?: boolean } = {}) => tabs.filter((t) => q.active !== true || t.active)
  chrome.tabs!.get = async (id: number) => tabs.find((t) => t.id === id)
  chrome.tabs!.create = async ({ url }: { url: string }) => {
    created.push(url)
    const tab: FakeTab = { id: 100 + created.length, url, title: 'Settings', active: false, windowId: 1 }
    tabs.push(tab)
    return tab
  }
  chrome.tabs!.update = async (id: number) => tabs.find((t) => t.id === id)
  chrome.windows!.update = async (id: number) => ({ id })
  host.addresses = PAGE
  host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
  host.addressPick = () => ({ position: 0 })
  host.mailStatus = () => CONNECTED
  host.mailSenders = () => SENDERS
})

const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined
const senderRow = (): HTMLElement | null => document.querySelector('[data-jff-email-sender]')
const senderSelect = (): HTMLSelectElement | null => senderRow()?.querySelector('select') ?? null
const sendRow = (): HTMLElement | null => document.querySelector('[data-jff-email-send]')
const reconnectButton = (): HTMLElement | null => sendRow() === null ? null : within(sendRow()!).queryByRole('button', { name: 'Reconnect' })
const bodyInput = (): HTMLTextAreaElement | null => document.querySelector('[data-jff-email-body] textarea')
const subjectInput = (): HTMLInputElement | null => document.querySelector('[data-jff-email-subject] input')
const sendersAsked = (): number => host.methods.filter((m) => m === 'mail.senders').length

async function draftShown(): Promise<ReturnType<typeof render>> {
  const view = render(<App />)
  await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
  await waitFor(() => { expect(bodyInput()).not.toBeNull() }, { timeout: 8_000 })
  return view
}

async function rowShown(): Promise<HTMLElement> {
  await waitFor(() => { expect(senderRow()).not.toBeNull() })
  return senderRow()!
}

describe('the Sender address row', () => {
  it('is a dropdown of the addresses the account may send as, each with its display name', async () => {
    await draftShown()
    await rowShown()
    const options = [...senderSelect()!.options].map((o) => [o.value, o.textContent])
    expect(options).toEqual([
      ['ada@example.com', 'Ada Lovelace <ada@example.com>'],
      ['ada@work.example.com', 'Ada at Work <ada@work.example.com>'],
    ])
    expect(sendersAsked()).toBe(1)
  }, 20_000)

  it('defaults to the account\'s own address when nothing was sent before', async () => {
    await draftShown()
    await rowShown()
    expect(senderSelect()!.value).toBe('ada@example.com')
  }, 20_000)

  it('defaults to the last used Sender address when the list still holds it', async () => {
    host.mailSenders = () => ({ ...SENDERS, lastUsed: 'ada@work.example.com' })
    await draftShown()
    await rowShown()
    expect(senderSelect()!.value).toBe('ada@work.example.com')
  }, 20_000)

  it('the last used one is matched without regard to case', async () => {
    host.mailSenders = () => ({ ...SENDERS, lastUsed: 'Ada@Work.Example.com' })
    await draftShown()
    await rowShown()
    expect(senderSelect()!.value).toBe('ada@work.example.com')
  }, 20_000)

  it('defaults to the account\'s own address when the list no longer holds the last used one', async () => {
    host.mailSenders = () => ({ ...SENDERS, lastUsed: 'ada@gone.example.com' })
    await draftShown()
    await rowShown()
    expect(senderSelect()!.value).toBe('ada@example.com')
  }, 20_000)

  it('the Session holds the choice, through a Side panel reload', async () => {
    const first = await draftShown()
    await rowShown()
    fireEvent.change(senderSelect()!, { target: { value: 'ada@work.example.com' } })
    await waitFor(() => { expect(sessionRow()?.senderAddress).toBe('ada@work.example.com') })
    first.unmount()
    render(<App />)
    await waitFor(() => { expect(senderSelect()?.value).toBe('ada@work.example.com') }, { timeout: 8_000 })
  }, 20_000)

  it('a Session choice the list no longer holds falls back to the default', async () => {
    const first = await draftShown()
    await rowShown()
    fireEvent.change(senderSelect()!, { target: { value: 'ada@work.example.com' } })
    await waitFor(() => { expect(sessionRow()?.senderAddress).toBe('ada@work.example.com') })
    first.unmount()
    host.mailSenders = () => ({ ...SENDERS, senders: [SENDERS.senders[0]!] })
    render(<App />)
    await rowShown()
    await waitFor(() => { expect(senderRow()!.textContent).toContain('ada@example.com') })
    expect(senderRow()!.textContent).not.toContain('ada@work.example.com')
  }, 20_000)

  it('with one address, as `own address only` leaves it, shows that address and no dropdown', async () => {
    host.mailSenders = () => ({ ...SENDERS, senders: [SENDERS.senders[0]!] })
    await draftShown()
    const row = await rowShown()
    await waitFor(() => { expect(row.textContent).toContain('ada@example.com') })
    expect(row.textContent).toContain('Ada Lovelace')
    expect(senderSelect()).toBeNull()
  }, 20_000)

  it('is not shown, nor asked for, with no Mail account', async () => {
    host.mailStatus = () => ({ state: 'none' })
    await draftShown()
    await waitFor(() => { expect(host.methods).toContain('mail.status') })
    await new Promise((ok) => setTimeout(ok, 50))
    expect(senderRow()).toBeNull()
    expect(sendersAsked()).toBe(0)
  }, 20_000)
})

describe('a sign-in that died', () => {
  it('shows Reconnect where Send will be, and no Sender address row', async () => {
    host.mailStatus = () => DIED
    await draftShown()
    await waitFor(() => { expect(reconnectButton()).not.toBeNull() })
    expect(senderRow()).toBeNull()
    expect(sendersAsked()).toBe(0)
  }, 20_000)

  it('shows Reconnect when the list finds the sign-in dead', async () => {
    const dead: MailSendersAnswer = { error: { kind: 'not_authed', message: 'The sign-in to this Mail account has expired or was revoked. Click Reconnect to sign in again.' } }
    host.mailSenders = () => dead
    await draftShown()
    await waitFor(() => { expect(reconnectButton()).not.toBeNull() })
    expect(senderRow()).toBeNull()
  }, 20_000)

  it('a list that fails for another reason shows no Reconnect', async () => {
    host.mailSenders = () => ({ error: { kind: 'process', message: 'Could not reach Google to refresh the sign-in: fetch failed' } })
    await draftShown()
    await waitFor(() => { expect(sendersAsked()).toBe(1) })
    await new Promise((ok) => setTimeout(ok, 50))
    expect(reconnectButton()).toBeNull()
  }, 20_000)

  it('keeps the Draft and its edits unchanged, and Reconnect opens the settings page', async () => {
    host.mailStatus = () => DIED
    await draftShown()
    const subject = 'My own subject'
    const body = `${bodyInput()!.value}\n\nP.S. A line of my own.`
    fireEvent.change(subjectInput()!, { target: { value: subject } })
    fireEvent.change(bodyInput()!, { target: { value: body } })
    await waitFor(() => { expect(reconnectButton()).not.toBeNull() })
    fireEvent.click(reconnectButton()!)
    await waitFor(() => { expect(created).toEqual([SETTINGS]) })
    expect(bodyInput()!.value).toBe(body)
    expect(subjectInput()!.value).toBe(subject)
    await waitFor(() => { expect(sessionRow()?.emailDraft?.body).toBe(body) })
    expect(sessionRow()?.emailDraft?.subject).toBe(subject)
    expect(sessionRow()?.emailDraft?.edited).toBe(true)
    expect(host.emailDrafts).toHaveLength(1)
  }, 20_000)

  it('after a Reconnect in the settings page, the panel shows the row again when it gets the focus back', async () => {
    let account: MailStatus = DIED
    host.mailStatus = () => account
    await draftShown()
    await waitFor(() => { expect(reconnectButton()).not.toBeNull() })
    account = CONNECTED
    window.dispatchEvent(new Event('focus'))
    await rowShown()
    expect(reconnectButton()).toBeNull()
  }, 20_000)
})
