import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HostResponse, MailSendersResult, MailStatus } from '@jff/shared'
import { SettingsPage } from './SettingsPage'
import { installFakeBrowser } from './testing/fakeBrowser'

/**
 * The connected Mail account on the settings page (spec #66, ticket #81),
 * rendered whole against the fake Native host: its state, its Sender
 * addresses, and Reconnect when the sign-in died. Reconnect runs the sign-in
 * again with the stored client: `mail.connect.start` with no client file.
 */

const browser = installFakeBrowser()

const CONSENT = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com&state=s2'
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

type Answer = (params: Record<string, unknown>) => { ok: true; result: unknown } | { ok: false; error: { kind: string; message: string } }

let requests: { method: string; params: Record<string, unknown> }[]
let answers: Record<string, Answer>
/** What the fake Native host holds. */
let account: MailStatus

beforeEach(() => {
  requests = []
  account = CONNECTED
  answers = {
    'mail.status': () => ({ ok: true, result: account }),
    'mail.senders': () => (account.state === 'connected'
      ? { ok: true, result: SENDERS }
      : { ok: false, error: { kind: 'not_authed', message: 'The sign-in to this Mail account has expired or was revoked. Click Reconnect to sign in again.' } }),
    'mail.connect.start': () => ({ ok: true, result: { consentUrl: CONSENT } }),
    'mail.connect.finish': () => { account = CONNECTED; return { ok: true, result: CONNECTED } },
    'mail.disconnect': () => { account = { state: 'none' }; return { ok: true, result: { revoked: true, warning: null } } },
  }
  window.__jffHostBridge = async ({ requestId, method, params }): Promise<HostResponse> => {
    requests.push({ method, params: params as Record<string, unknown> })
    const answer = answers[method]
    if (answer === undefined) throw new Error(`no answer for ${method}`)
    return { requestId, ...answer(params as Record<string, unknown>) } as HostResponse
  }
})

afterEach(() => { delete window.__jffHostBridge })

const methods = (): string[] => requests.map((r) => r.method)
const mail = (): HTMLElement => screen.getByRole('region', { name: 'Mail' })
const card = (): HTMLElement => mail().querySelector<HTMLElement>('[data-jff-mail-account]')!
const stateText = (): string => card().querySelector('[data-jff-mail-state]')?.textContent ?? ''
const senderRows = (): string[] =>
  [...mail().querySelectorAll<HTMLElement>('[data-jff-sender-address]')].map((r) => r.textContent!.replace(/\s+/g, ' ').trim())
const reconnectButton = (): HTMLElement | null => within(mail()).queryByRole('button', { name: 'Reconnect' })

async function page(): Promise<void> {
  render(<SettingsPage />)
  await waitFor(() => expect(within(mail()).getByText('ada@example.com', { selector: '[data-jff-mail-address]' })).not.toBeNull())
}

describe('a connected Mail account', () => {
  it('shows its state', async () => {
    await page()
    await waitFor(() => expect(stateText()).toBe('Connected'))
  })

  it('lists its Sender addresses, each with its display name', async () => {
    await page()
    await waitFor(() => expect(senderRows()).toEqual([
      'Ada Lovelace ada@example.com',
      'Ada at Work ada@work.example.com',
    ]))
    expect(methods()).toEqual(['mail.status', 'mail.senders'])
  })

  it('lists the own address alone when that is the whole list', async () => {
    answers['mail.senders'] = () => ({ ok: true, result: { ...SENDERS, senders: [SENDERS.senders[0]!] } })
    await page()
    await waitFor(() => expect(senderRows()).toEqual(['Ada Lovelace ada@example.com']))
  })

  it('shows no Reconnect', async () => {
    await page()
    await waitFor(() => expect(senderRows()).toHaveLength(2))
    expect(reconnectButton()).toBeNull()
  })

  it('says why when the list cannot be read, and stays connected', async () => {
    answers['mail.senders'] = () => ({ ok: false, error: { kind: 'process', message: 'Could not reach Google to refresh the sign-in: fetch failed' } })
    await page()
    await waitFor(() => expect(within(card()).getByRole('alert').textContent).toMatch(/fetch failed/))
    expect(stateText()).toBe('Connected')
    expect(reconnectButton()).toBeNull()
  })
})

describe('a Mail account whose sign-in died', () => {
  it('shows the state "Needs reconnect" and Reconnect', async () => {
    account = DIED
    await page()
    expect(stateText()).toBe('Needs reconnect')
    expect(reconnectButton()).not.toBeNull()
    expect(card().contains(reconnectButton())).toBe(true)
  })

  it('asks for no Sender addresses', async () => {
    account = DIED
    await page()
    expect(methods()).toEqual(['mail.status'])
    expect(senderRows()).toEqual([])
  })

  it('turns to "Needs reconnect" when the list finds the sign-in dead', async () => {
    answers['mail.senders'] = () => {
      account = DIED
      return { ok: false, error: { kind: 'not_authed', message: 'The sign-in to this Mail account has expired or was revoked.' } }
    }
    await page()
    await waitFor(() => expect(stateText()).toBe('Needs reconnect'))
    expect(reconnectButton()).not.toBeNull()
  })
})

describe('Reconnect', () => {
  it('starts a sign-in with no client file and opens Google\'s page in a tab', async () => {
    account = DIED
    await page()
    fireEvent.click(reconnectButton()!)
    await waitFor(() => expect(browser.opened).toEqual([CONSENT]))
    const start = requests.find((r) => r.method === 'mail.connect.start')!
    expect(start.params).toEqual({})
    expect(methods()).toContain('mail.connect.finish')
  })

  it('a finished one shows the account connected and its Sender addresses', async () => {
    account = DIED
    await page()
    fireEvent.click(reconnectButton()!)
    await waitFor(() => expect(stateText()).toBe('Connected'))
    await waitFor(() => expect(senderRows()).toHaveLength(2))
    expect(reconnectButton()).toBeNull()
  })

  it('a refused start says why and keeps Reconnect', async () => {
    account = DIED
    answers['mail.connect.start'] = () => ({ ok: false, error: { kind: 'bad_request', message: 'There is no stored client to reconnect with. Drop the client file in the settings page and click Connect.' } })
    await page()
    fireEvent.click(reconnectButton()!)
    await waitFor(() => expect(within(card()).getByRole('alert').textContent).toMatch(/client file/))
    expect(browser.opened).toEqual([])
    expect(stateText()).toBe('Needs reconnect')
    expect(reconnectButton()).not.toBeNull()
  })
})
