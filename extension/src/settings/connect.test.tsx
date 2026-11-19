import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HostResponse, MailStatus } from '@jff/shared'
import { SettingsPage } from './SettingsPage'
import { installFakeBrowser } from './testing/fakeBrowser'

/**
 * Connect a Gmail Mail account (spec #66, ticket #79), on the settings page
 * rendered whole against the fake Native host. The wizard's last two steps
 * take the client file the user downloaded and Connect; the sign-in opens in
 * a tab of the same Chrome, and the Mail section then shows the connected
 * address and since when.
 */

const browser = installFakeBrowser()

const CONSENT = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com&state=s1'
const SECRET = 'CLIENT_SECRET_PLACEHOLDER'
const DESKTOP = JSON.stringify({ installed: { client_id: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com', client_secret: SECRET } })
const CONNECTED: MailStatus = { state: 'connected', kind: 'gmail', address: 'ada@example.com', connectedAt: '2026-11-19T12:00:00.000Z' }
const WRONG_TYPE = 'This client file is for a Web application. This is not the client file of a Desktop app. In the Google Cloud console, create an OAuth client whose Application type is Desktop app.'

type Answer = (params: Record<string, unknown>) => { ok: true; result: unknown } | { ok: false; error: { kind: string; message: string } }

let requests: { method: string; params: Record<string, unknown> }[]
let answers: Record<string, Answer>

beforeEach(() => {
  requests = []
  answers = {
    'mail.status': () => ({ ok: true, result: { state: 'none' } }),
    'mail.connect.start': () => ({ ok: true, result: { consentUrl: CONSENT } }),
    'mail.connect.finish': () => ({ ok: true, result: CONNECTED }),
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
const connectButton = (): HTMLButtonElement => within(mail()).getByRole('button', { name: 'Connect' }) as HTMLButtonElement
const clientFile = (text = DESKTOP, name = 'client_secret_ada.apps.googleusercontent.com.json'): File =>
  new File([text], name, { type: 'application/json' })

async function wizard(): Promise<void> {
  render(<SettingsPage />)
  await waitFor(() => expect(document.querySelector('[data-jff-wizard-loaded]')).not.toBeNull())
}

async function drop(file = clientFile()): Promise<void> {
  const zone = mail().querySelector<HTMLElement>('[data-jff-client-drop]')!
  fireEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } })
  await waitFor(() => expect(mail().textContent).toContain(`Read ${file.name}`))
}

describe('the wizard\'s last two steps', () => {
  it('follow the console steps: the client file, then Connect', async () => {
    await wizard()
    const titles = [...mail().querySelectorAll('li h3')].map((h) => h.textContent!.replace(/^\d+\.\s*/, ''))
    expect(titles.slice(-2)).toEqual(['Give the wizard your client file', 'Connect'])
    expect(titles).toHaveLength(10)
  })

  it('Connect waits for a client file', async () => {
    await wizard()
    expect(connectButton().disabled).toBe(true)
    await drop()
    expect(connectButton().disabled).toBe(false)
  })

  it('a client file can be chosen as well as dropped', async () => {
    await wizard()
    const file = clientFile()
    fireEvent.change(within(mail()).getByLabelText('Client file'), { target: { files: [file] } })
    await waitFor(() => expect(mail().textContent).toContain(`Read ${file.name}`))
    expect(connectButton().disabled).toBe(false)
  })
})

describe('Connect', () => {
  it('walks from the dropped file to the connected address and date', async () => {
    await wizard()
    await drop()
    fireEvent.click(connectButton())

    await waitFor(() => expect(within(mail()).getByText('ada@example.com')).not.toBeNull())
    expect(mail().textContent).toContain('Connected since November 19, 2026')
    expect(methods()).toEqual(['mail.status', 'mail.connect.start', 'mail.connect.finish'])
    expect(requests[1]!.params).toEqual({ clientFile: DESKTOP })
    // The sign-in opens in a tab of the same Chrome.
    expect(browser.opened).toEqual([CONSENT])
    expect(document.querySelector('[data-jff-wizard]')).toBeNull()
  })

  it('says it waits for the sign-in while the tab is open', async () => {
    let finish!: (r: { ok: true; result: unknown }) => void
    const base = window.__jffHostBridge!
    window.__jffHostBridge = async (req) => req.method === 'mail.connect.finish'
      ? new Promise<HostResponse>((ok) => { requests.push({ method: req.method, params: {} }); finish = (r) => ok({ requestId: req.requestId, ...r }) })
      : base(req)
    await wizard()
    await drop()
    fireEvent.click(connectButton())
    await waitFor(() => expect(mail().textContent).toContain('Waiting for the sign-in in the tab that opened'))
    expect(connectButton().disabled).toBe(true)
    finish({ ok: true, result: CONNECTED })
    await waitFor(() => expect(within(mail()).getByText('ada@example.com')).not.toBeNull())
  })

  it('shows the message that names the Desktop type for a client file of another type, and opens nothing', async () => {
    answers['mail.connect.start'] = () => ({ ok: false, error: { kind: 'bad_request', message: WRONG_TYPE } })
    await wizard()
    await drop(clientFile('{"web": {}}', 'client_secret_web.json'))
    fireEvent.click(connectButton())
    const alert = await within(mail()).findByRole('alert')
    expect(alert.textContent).toContain('Desktop app')
    expect(browser.opened).toEqual([])
    expect(methods()).not.toContain('mail.connect.finish')
    expect(document.querySelector('[data-jff-wizard]')).not.toBeNull()
  })

  it('a sign-in that never came back says so, and Connect can be clicked again', async () => {
    answers['mail.connect.finish'] = () => ({ ok: false, error: { kind: 'timeout', message: 'The sign-in did not come back within 5 minutes. Nothing was connected. Click Connect to try again.' } })
    await wizard()
    await drop()
    fireEvent.click(connectButton())
    const alert = await within(mail()).findByRole('alert')
    expect(alert.textContent).toContain('did not come back within 5 minutes')
    expect(connectButton().disabled).toBe(false)
  })

  it('keeps the client file in no storage', async () => {
    await wizard()
    await drop()
    fireEvent.click(connectButton())
    await waitFor(() => expect(within(mail()).getByText('ada@example.com')).not.toBeNull())
    expect(JSON.stringify([browser.local, browser.session])).not.toContain(SECRET)
  })
})

describe('the Mail section with a Mail account', () => {
  it('shows the connected address and since when, and no wizard', async () => {
    answers['mail.status'] = () => ({ ok: true, result: CONNECTED })
    render(<SettingsPage />)
    await waitFor(() => expect(within(mail()).getByText('ada@example.com')).not.toBeNull())
    expect(mail().textContent).toContain('Connected since November 19, 2026')
    expect(document.querySelector('[data-jff-wizard]')).toBeNull()
  })

  it('says when the sign-in needs reconnecting', async () => {
    answers['mail.status'] = () => ({ ok: true, result: { ...CONNECTED, state: 'needs_reconnect' } })
    render(<SettingsPage />)
    await waitFor(() => expect(within(mail()).getByText('ada@example.com')).not.toBeNull())
    expect(mail().textContent).toMatch(/needs reconnecting/i)
  })

  it('shows why when the Native host cannot say, above the console steps, which need no host', async () => {
    answers['mail.status'] = () => ({ ok: false, error: { kind: 'db', message: 'The database comes from a newer version of the tool.' } })
    render(<SettingsPage />)
    const alert = await within(mail()).findByRole('alert')
    expect(alert.textContent).toContain('newer version of the tool')
    await waitFor(() => expect(document.querySelector('[data-jff-wizard-loaded]')).not.toBeNull())
  })
})
