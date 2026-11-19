import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MailError, type PendingConnect } from './account.js'
import { createGmailDriver, gmailScopes, SENDER_ADDRESSES } from './gmail.js'
import { GOOGLE_ORIGINS, googleOnly, type HttpRequest, type HttpResponse } from './net.js'

/**
 * The Gmail driver's connect (spec #66), against the code exchange the
 * research ticket recorded (`e2e/fixtures/gmail/code-exchange.json`), with the
 * network call injected. The loopback listener is real: the tests play the
 * browser coming back from Google's consent page.
 */

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '../../..')
const TRANSCRIPT = JSON.parse(readFileSync(resolve(REPO, 'e2e/fixtures/gmail/code-exchange.json'), 'utf8')) as {
  request: HttpRequest
  response: HttpResponse
}
const FACTS = readFileSync(resolve(REPO, 'docs/research/apply-by-email-facts.md'), 'utf8')

const CLIENT_ID = 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com'
const CLIENT_SECRET = 'CLIENT_SECRET_PLACEHOLDER'
const CODE = 'AUTH_CODE_PLACEHOLDER'

/** The JSON Google's console downloads for a client of this type. */
const clientFile = (type: 'installed' | 'web'): string => JSON.stringify({
  [type]: {
    client_id: CLIENT_ID, project_id: 'ada-jff-4242',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_secret: CLIENT_SECRET, redirect_uris: ['http://localhost'],
  },
})
const DESKTOP = clientFile('installed')

const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url')

/** An ID token as the token endpoint returns it. The recorded one is a
 *  placeholder; this one carries the persona's address, unsigned. */
const idToken = (claims: Record<string, unknown> = {}): string =>
  [b64url('{"alg":"RS256"}'), b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email: 'ada@example.com', email_verified: true, ...claims })), 'sig'].join('.')

/** The network, as the recorded transcript answered it. */
function recordedNetwork(response: HttpResponse = {
  ...TRANSCRIPT.response, body: TRANSCRIPT.response.body.replace('ID_TOKEN_PLACEHOLDER', idToken()),
}): { calls: HttpRequest[]; http: (req: HttpRequest) => Promise<HttpResponse> } {
  const calls: HttpRequest[] = []
  return { calls, http: async (req) => { calls.push(req); return response } }
}

const open: PendingConnect[] = []
afterEach(() => { for (const p of open.splice(0)) p.cancel() })

async function start(http = recordedNetwork().http, file = DESKTOP): Promise<PendingConnect> {
  const pending = await createGmailDriver({ http }).connect(file)
  open.push(pending)
  // A test that never awaits the result must not leave a rejection unhandled.
  pending.result.catch(() => {})
  return pending
}

const consentOf = (p: PendingConnect): URL => new URL(p.consentUrl)

/** The browser coming back from Google to the listener. */
async function returnFromGoogle(p: PendingConnect, query: Record<string, string>): Promise<{ status: number; text: string }> {
  const url = new URL(consentOf(p).searchParams.get('redirect_uri')!)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const res = await fetch(url)
  return { status: res.status, text: await res.text() }
}

const stateOf = (p: PendingConnect): string => consentOf(p).searchParams.get('state')!

async function refused(url: string): Promise<boolean> {
  try { await fetch(url); return false } catch { return true }
}

const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e)

describe('the consent address', () => {
  it('asks for the scopes the research document\'s Sender addresses line names, and nothing that reads mail', async () => {
    const mode = /^Sender addresses: (.+)$/m.exec(FACTS)![1]!.trim()
    expect(SENDER_ADDRESSES).toBe(mode)
    expect(mode).toBe('dropdown')
    const p = await start()
    const scopes = consentOf(p).searchParams.get('scope')!.split(' ')
    expect(scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.settings.basic',
      'openid',
      'email',
    ])
    expect(gmailScopes('own address only')).toEqual(['https://www.googleapis.com/auth/gmail.send', 'openid', 'email'])
    for (const s of [...scopes, ...gmailScopes('own address only')]) {
      expect(s).not.toMatch(/readonly|modify|metadata|compose|insert|mail\.google\.com|gmail\.labels/)
    }
  })

  it('carries a PKCE challenge with S256, a state value and a loopback return address', async () => {
    const p = await start()
    const url = consentOf(p)
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    // A refresh token on every sign-in, also for an account that consented before.
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })

  it('a second sign-in gets its own state and challenge', async () => {
    const a = consentOf(await start())
    const b = consentOf(await start())
    expect(a.searchParams.get('state')).not.toBe(b.searchParams.get('state'))
    expect(a.searchParams.get('code_challenge')).not.toBe(b.searchParams.get('code_challenge'))
  })
})

describe('the client file', () => {
  it('refuses a client file of another type, with a message that names the Desktop type', async () => {
    const net = recordedNetwork()
    const error = await rejection(createGmailDriver({ http: net.http }).connect(clientFile('web')))
    expect(error).toBeInstanceOf(MailError)
    expect((error as MailError).kind).toBe('bad_request')
    expect((error as MailError).message).toMatch(/Desktop app/)
    expect((error as MailError).message).not.toContain(CLIENT_SECRET)
    expect(net.calls).toEqual([])
  })

  it('refuses a file that is not Google\'s JSON', async () => {
    for (const text of ['not json at all', '{"installed": {"client_id": "x"}}', '[]']) {
      const error = await rejection(createGmailDriver({ http: recordedNetwork().http }).connect(text))
      expect((error as MailError).kind).toBe('bad_request')
      expect((error as MailError).message).toMatch(/Desktop app/)
    }
  })
})

describe('the sign-in coming back', () => {
  it('exchanges the code as the recorded transcript did, and answers the account', async () => {
    const net = recordedNetwork()
    const p = await start(net.http)
    const browser = await returnFromGoogle(p, { state: stateOf(p), code: CODE, scope: 'email openid' })
    expect(browser.status).toBe(200)
    expect(browser.text).toContain('Signed in. You can close this tab.')

    expect(await p.result).toEqual({
      address: 'ada@example.com', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: 'REFRESH_TOKEN_PLACEHOLDER',
    })
    expect(net.calls).toHaveLength(1)
    const sent = net.calls[0]!
    const body = new URLSearchParams(sent.body)
    const verifier = body.get('code_verifier')!
    // The verifier is the one the consent address's challenge was made from.
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(consentOf(p).searchParams.get('code_challenge'))
    const port = new URL(consentOf(p).searchParams.get('redirect_uri')!).port
    // The recorded call, with this run's verifier and port in place of the transcript's.
    expect({
      ...sent,
      body: sent.body!.replace(verifier, 'CODE_VERIFIER_PLACEHOLDER').replace(`%3A${port}`, '%3A49152'),
    }).toEqual(TRANSCRIPT.request)
    // Answer 4: the exchange carries the client secret.
    expect(body.get('client_secret')).toBe(CLIENT_SECRET)
  })

  it('refuses a return with a wrong state, exchanges nothing and closes', async () => {
    const net = recordedNetwork()
    const p = await start(net.http)
    const redirect = consentOf(p).searchParams.get('redirect_uri')!
    const browser = await returnFromGoogle(p, { state: 'forged-state-value', code: CODE })
    expect(browser.status).toBe(400)
    const error = await rejection(p.result)
    expect(error).toBeInstanceOf(MailError)
    expect((error as MailError).kind).toBe('bad_request')
    expect((error as MailError).message).toMatch(/state/)
    expect(net.calls).toEqual([])
    expect(await refused(redirect)).toBe(true)
  })

  it('takes one return and then closes', async () => {
    const p = await start()
    const redirect = consentOf(p).searchParams.get('redirect_uri')!
    await returnFromGoogle(p, { state: stateOf(p), code: CODE })
    await p.result
    expect(await refused(`${redirect}/?state=${stateOf(p)}&code=again`)).toBe(true)
  })

  it('binds to loopback only', async () => {
    const p = await start()
    const port = new URL(consentOf(p).searchParams.get('redirect_uri')!).port
    const outside = Object.values(networkInterfaces()).flat()
      .filter((i) => i !== undefined && i.family === 'IPv4' && !i.internal).map((i) => i!.address)
    for (const address of outside) expect(await refused(`http://${address}:${port}/`)).toBe(true)
    // The listener still waits on loopback: an address elsewhere took nothing.
    const browser = await returnFromGoogle(p, { state: stateOf(p), code: CODE })
    expect(browser.status).toBe(200)
  })

  it('answers a sign-in the user cancelled at Google as not signed in, and exchanges nothing', async () => {
    const net = recordedNetwork()
    const p = await start(net.http)
    await returnFromGoogle(p, { state: stateOf(p), error: 'access_denied' })
    const error = await rejection(p.result)
    expect((error as MailError).kind).toBe('not_authed')
    expect(net.calls).toEqual([])
  })

  it('refuses a sign-in that did not grant every Gmail permission', async () => {
    const body = TRANSCRIPT.response.body
      .replace('ID_TOKEN_PLACEHOLDER', idToken())
      .replace('https://www.googleapis.com/auth/gmail.send ', '')
    const p = await start(recordedNetwork({ ...TRANSCRIPT.response, body }).http)
    await returnFromGoogle(p, { state: stateOf(p), code: CODE })
    const error = await rejection(p.result)
    expect((error as MailError).kind).toBe('not_authed')
    expect((error as MailError).message).toMatch(/gmail\.send/)
  })

  it('refuses an ID token issued to another client', async () => {
    const body = TRANSCRIPT.response.body.replace('ID_TOKEN_PLACEHOLDER', idToken({ aud: 'someone-else.apps.googleusercontent.com' }))
    const p = await start(recordedNetwork({ ...TRANSCRIPT.response, body }).http)
    await returnFromGoogle(p, { state: stateOf(p), code: CODE })
    expect(await rejection(p.result)).toBeInstanceOf(MailError)
  })

  it('answers an exchange Google refused as not signed in, without a secret in the message', async () => {
    const p = await start(recordedNetwork({
      status: 400, headers: { 'content-type': 'application/json' },
      body: '{"error": "invalid_grant", "error_description": "Bad Request"}',
    }).http)
    await returnFromGoogle(p, { state: stateOf(p), code: CODE })
    const error = await rejection(p.result)
    expect((error as MailError).kind).toBe('not_authed')
    expect((error as MailError).message).toContain('invalid_grant')
    expect((error as MailError).message).not.toContain(CLIENT_SECRET)
  })

  it('cancel closes the listener and ends the sign-in', async () => {
    const p = await start()
    const redirect = consentOf(p).searchParams.get('redirect_uri')!
    p.cancel()
    expect(await rejection(p.result)).toBeInstanceOf(MailError)
    expect(await refused(redirect)).toBe(true)
  })
})

describe('the network', () => {
  it('every address the driver calls belongs to Google\'s sign-in, token or Gmail endpoints', async () => {
    const net = recordedNetwork()
    const p = await start(net.http)
    await returnFromGoogle(p, { state: stateOf(p), code: CODE })
    await p.result
    expect(net.calls.length).toBeGreaterThan(0)
    for (const call of net.calls) expect(GOOGLE_ORIGINS).toContain(new URL(call.url).origin)
    expect(GOOGLE_ORIGINS).toEqual(['https://accounts.google.com', 'https://oauth2.googleapis.com', 'https://gmail.googleapis.com'])
  })

  it('a call to any other address is refused before it is made', async () => {
    const net = recordedNetwork()
    const guarded = googleOnly(net.http)
    for (const url of ['https://example.com/token', 'http://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com.example.com/x', 'nonsense']) {
      expect(await rejection(guarded({ method: 'GET', url, headers: {} }))).toBeInstanceOf(MailError)
    }
    expect(net.calls).toEqual([])
  })
})
