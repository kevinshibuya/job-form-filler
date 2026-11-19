import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HostResponse, MailStatus } from '@jff/shared'
import { SettingsPage } from './SettingsPage'
import { installFakeBrowser } from './testing/fakeBrowser'
import { WIZARD_KEY } from './wizardStore'

/**
 * Disconnect the Mail account (spec #66, ticket #80), on the settings page
 * rendered whole against the fake Native host. Disconnect sits beside the
 * connected account; after it the Mail section shows the wizard again, with
 * the steps marked done still marked, and a new Connect works.
 */

const browser = installFakeBrowser()

const CONSENT = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com&state=s1'
const DESKTOP = JSON.stringify({ installed: { client_id: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com', client_secret: 'CLIENT_SECRET_PLACEHOLDER' } })
const CONNECTED: MailStatus = { state: 'connected', kind: 'gmail', address: 'ada@example.com', connectedAt: '2026-11-19T12:00:00.000Z' }
const NOT_REVOKED = 'The sign-in could not be revoked at Google (Could not reach Google to revoke the sign-in: fetch failed). The tool has forgotten the account and its secrets.'

type Answer = () => { ok: true; result: unknown } | { ok: false; error: { kind: string; message: string } }

let requests: string[]
let answers: Record<string, Answer>
/** What the fake Native host holds: the account, until Disconnect. */
let account: MailStatus

beforeEach(() => {
  requests = []
  account = CONNECTED
  answers = {
    'mail.status': () => ({ ok: true, result: account }),
    'mail.disconnect': () => { account = { state: 'none' }; return { ok: true, result: { revoked: true, warning: null } } },
    'mail.connect.start': () => ({ ok: true, result: { consentUrl: CONSENT } }),
    'mail.connect.finish': () => { account = CONNECTED; return { ok: true, result: CONNECTED } },
    // A connected account lists its Sender addresses (ticket #81).
    'mail.senders': () => ({ ok: true, result: { address: 'ada@example.com', senders: [{ address: 'ada@example.com', displayName: 'Ada Lovelace' }], lastUsed: null } }),
  }
  window.__jffHostBridge = async ({ requestId, method }): Promise<HostResponse> => {
    requests.push(method)
    const answer = answers[method]
    if (answer === undefined) throw new Error(`no answer for ${method}`)
    return { requestId, ...answer() } as HostResponse
  }
})

afterEach(() => { delete window.__jffHostBridge })

const mail = (): HTMLElement => screen.getByRole('region', { name: 'Mail' })
const disconnectButton = (): HTMLElement => within(mail()).getByRole('button', { name: 'Disconnect' })
const doneSteps = (): number[] =>
  [...document.querySelectorAll<HTMLElement>('[data-jff-step][data-jff-done="1"]')].map((c) => Number(c.dataset.jffStep))

async function connectedPage(): Promise<void> {
  render(<SettingsPage />)
  await waitFor(() => expect(within(mail()).getByText('ada@example.com')).not.toBeNull())
}

describe('Disconnect', () => {
  it('sits beside the connected account', async () => {
    await connectedPage()
    const card = mail().querySelector('[data-jff-mail-account]')!
    expect(card.contains(disconnectButton())).toBe(true)
  })

  it('sends mail.disconnect and returns the section to the wizard', async () => {
    await connectedPage()
    fireEvent.click(disconnectButton())
    await waitFor(() => expect(document.querySelector('[data-jff-wizard-loaded]')).not.toBeNull())
    expect(requests).toEqual(['mail.status', 'mail.senders', 'mail.disconnect'])
    expect(within(mail()).queryByText('ada@example.com')).toBeNull()
    expect(document.querySelector('[data-jff-mail-account]')).toBeNull()
  })

  it('the wizard comes back with its finished steps still marked', async () => {
    browser.local[WIZARD_KEY] = { projectId: 'ada-jff-4242', done: [1, 2, 3, 4, 5] }
    await connectedPage()
    fireEvent.click(disconnectButton())
    await waitFor(() => expect(document.querySelector('[data-jff-wizard-loaded]')).not.toBeNull())
    expect(doneSteps()).toEqual([1, 2, 3, 4, 5])
  })

  it('says so when Google could not revoke the token, and still shows the wizard', async () => {
    answers['mail.disconnect'] = () => { account = { state: 'none' }; return { ok: true, result: { revoked: false, warning: NOT_REVOKED } } }
    await connectedPage()
    fireEvent.click(disconnectButton())
    await waitFor(() => expect(document.querySelector('[data-jff-wizard-loaded]')).not.toBeNull())
    expect(mail().querySelector('[data-jff-disconnect-warning]')?.textContent).toContain('could not be revoked at Google')
  })

  it('a refused Disconnect keeps the account and says why', async () => {
    answers['mail.disconnect'] = () => ({ ok: false, error: { kind: 'process', message: 'the Keychain refused to delete gmail:ada@example.com:refresh_token (security exited 1)' } })
    await connectedPage()
    fireEvent.click(disconnectButton())
    const alert = await within(mail()).findByRole('alert')
    expect(alert.textContent).toContain('Keychain refused')
    // The account's address, which its Sender addresses list again (ticket #81).
    expect(within(mail()).getByText('ada@example.com', { selector: '[data-jff-mail-address]' })).not.toBeNull()
    expect(document.querySelector('[data-jff-wizard]')).toBeNull()
  })

  it('a new Connect works after it', async () => {
    await connectedPage()
    fireEvent.click(disconnectButton())
    await waitFor(() => expect(document.querySelector('[data-jff-wizard-loaded]')).not.toBeNull())

    const file = new File([DESKTOP], 'client_secret_ada.apps.googleusercontent.com.json', { type: 'application/json' })
    fireEvent.drop(mail().querySelector<HTMLElement>('[data-jff-client-drop]')!, { dataTransfer: { files: [file], types: ['Files'] } })
    await waitFor(() => expect(mail().textContent).toContain(`Read ${file.name}`))
    fireEvent.click(within(mail()).getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(within(mail()).getByText('ada@example.com')).not.toBeNull())
    await waitFor(() => expect(requests).toEqual(['mail.status', 'mail.senders', 'mail.disconnect', 'mail.connect.start', 'mail.connect.finish', 'mail.senders']))
    expect(browser.opened).toEqual([CONSENT])
    expect(document.querySelector('[data-jff-disconnect-warning]')).toBeNull()
  })

  it('an account that needs a reconnect can be disconnected too', async () => {
    account = { ...CONNECTED, state: 'needs_reconnect' }
    await connectedPage()
    fireEvent.click(disconnectButton())
    await waitFor(() => expect(document.querySelector('[data-jff-wizard-loaded]')).not.toBeNull())
  })
})
