import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asMailError, type SignedInAccount } from './account.js'
import { createGmailDriver, type SenderAddressesMode } from './gmail.js'
import type { HttpRequest, HttpResponse } from './net.js'

/**
 * The Gmail driver's Sender addresses (spec #66, ticket #81), against the
 * transcripts the research ticket recorded under `e2e/fixtures/gmail/`, with
 * the network call injected: a token refresh, a refresh refused with
 * `invalid_grant`, and the "Send mail as" list.
 */

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '../../..')
interface Transcript { request: HttpRequest; response: HttpResponse }
const transcript = (name: string): Transcript =>
  JSON.parse(readFileSync(resolve(REPO, 'e2e/fixtures/gmail', name), 'utf8')) as Transcript

const REFRESH = transcript('token-refresh.json')
const INVALID_GRANT = transcript('refresh-invalid-grant.json')
const SEND_AS = transcript('send-as-list.json')

const ACCESS_TOKEN = 'ACCESS_TOKEN_PLACEHOLDER'
const ACCOUNT: SignedInAccount = {
  address: 'ada@example.com',
  clientId: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com',
  clientSecret: 'CLIENT_SECRET_PLACEHOLDER',
  refreshToken: 'REFRESH_TOKEN_PLACEHOLDER',
}

/** The network, answering each recorded request with its recorded response. */
function recorded(refresh: Transcript = REFRESH, sendAs: Transcript = SEND_AS): {
  calls: HttpRequest[]; http: (req: HttpRequest) => Promise<HttpResponse>
} {
  const calls: HttpRequest[] = []
  return {
    calls,
    http: async (req) => {
      calls.push(req)
      if (req.url === refresh.request.url) return refresh.response
      if (req.url === sendAs.request.url) return sendAs.response
      throw new Error(`no recording for ${req.url}`)
    },
  }
}

const driverOn = (http: (req: HttpRequest) => Promise<HttpResponse>, mode: SenderAddressesMode = 'dropdown') =>
  createGmailDriver({ http, senderAddresses: mode })

async function failure(p: Promise<unknown>): Promise<{ kind: string; message: string }> {
  try { await p } catch (e) {
    const mail = asMailError(e)
    if (mail === null) throw e
    return mail
  }
  throw new Error('expected a failure')
}

describe('the access token', () => {
  it('comes from the refresh token, with the request the transcript recorded', async () => {
    const net = recorded()
    await driverOn(net.http).senderAddresses(ACCOUNT)
    expect(net.calls[0]).toEqual(REFRESH.request)
  })

  it('is asked once while it lasts, not on every call', async () => {
    const net = recorded()
    const driver = driverOn(net.http)
    await driver.senderAddresses(ACCOUNT)
    await driver.senderAddresses(ACCOUNT)
    expect(net.calls.filter((c) => c.url === REFRESH.request.url)).toHaveLength(1)
  })

  it('is asked again once it has expired', async () => {
    const net = recorded()
    let now = 0
    const driver = createGmailDriver({ http: net.http, senderAddresses: 'dropdown', now: () => now })
    await driver.senderAddresses(ACCOUNT)
    now = 3_600_000
    await driver.senderAddresses(ACCOUNT)
    expect(net.calls.filter((c) => c.url === REFRESH.request.url)).toHaveLength(2)
  })
})

describe('a refresh Google refuses', () => {
  it('with invalid_grant fails as a sign-in that died: not_authed', async () => {
    const net = recorded(INVALID_GRANT)
    const err = await failure(driverOn(net.http).senderAddresses(ACCOUNT))
    expect(err.kind).toBe('not_authed')
    expect(err.message).toMatch(/Reconnect/)
    // Nothing is asked of Gmail without a token.
    expect(net.calls.map((c) => c.url)).toEqual([INVALID_GRANT.request.url])
  })

  it('a network failure is not a dead sign-in', async () => {
    const http = async (): Promise<HttpResponse> => { throw new TypeError('fetch failed') }
    const err = await failure(driverOn(http).senderAddresses(ACCOUNT))
    expect(err.kind).not.toBe('not_authed')
    expect(err.message).toMatch(/fetch failed/)
  })

  it('a server error from Google is not a dead sign-in', async () => {
    const http = async (): Promise<HttpResponse> => ({ status: 503, headers: {}, body: '{"error": "backend_error"}' })
    const err = await failure(driverOn(http).senderAddresses(ACCOUNT))
    expect(err.kind).not.toBe('not_authed')
  })
})

describe('the "Send mail as" list', () => {
  it('is read with the access token, with the request the transcript recorded', async () => {
    const net = recorded()
    await driverOn(net.http).senderAddresses(ACCOUNT)
    // The recording writes a GET's absent body as "". Fetch refuses a GET
    // with any body, so the driver sends none.
    const { body, ...recordedGet } = SEND_AS.request
    expect(body).toBe('')
    expect(net.calls[1]).toEqual(recordedGet)
  })

  it('holds the account\'s own address and each verified address, and no unverified one', async () => {
    const list = await driverOn(recorded().http).senderAddresses(ACCOUNT)
    expect(list.map((s) => s.address)).toEqual(['ada@example.com', 'ada@work.example.com'])
  })

  it('an entry with a name keeps it, and one without has none for the request to fill', async () => {
    const list = await driverOn(recorded().http).senderAddresses(ACCOUNT)
    expect(list).toEqual([
      { address: 'ada@example.com', displayName: null },
      { address: 'ada@work.example.com', displayName: 'Ada Lovelace' },
    ])
  })

  it('puts the account\'s own address first even when Gmail lists it later', async () => {
    const body = JSON.parse(SEND_AS.response.body) as { sendAs: unknown[] }
    const reordered = { ...SEND_AS, response: { ...SEND_AS.response, body: JSON.stringify({ sendAs: [...body.sendAs].reverse() }) } }
    const list = await driverOn(recorded(REFRESH, reordered).http).senderAddresses(ACCOUNT)
    expect(list[0]!.address).toBe('ada@example.com')
  })

  it('a refused list call fails without naming the access token', async () => {
    const refusedList = { ...SEND_AS, response: { status: 403, headers: {}, body: '{"error": {"code": 403, "status": "PERMISSION_DENIED"}}' } }
    const err = await failure(driverOn(recorded(REFRESH, refusedList).http).senderAddresses(ACCOUNT))
    expect(err.message).toMatch(/403/)
    expect(err.message).not.toContain(ACCESS_TOKEN)
  })
})

describe('with `own address only` in the research document', () => {
  it('makes no "Send mail as" call and lists the own address alone, with no name', async () => {
    const net = recorded()
    const list = await driverOn(net.http, 'own address only').senderAddresses(ACCOUNT)
    expect(net.calls.map((c) => c.url)).toEqual([REFRESH.request.url])
    expect(list).toEqual([{ address: 'ada@example.com', displayName: null }])
  })

  it('still learns that the sign-in died', async () => {
    const err = await failure(driverOn(recorded(INVALID_GRANT).http, 'own address only').senderAddresses(ACCOUNT))
    expect(err.kind).toBe('not_authed')
  })
})

describe('no secret leaves in an error', () => {
  it('neither the refresh token, the client secret nor the access token is in any failure message', async () => {
    const errors = [
      await failure(driverOn(recorded(INVALID_GRANT).http).senderAddresses(ACCOUNT)),
      await failure(driverOn(async () => { throw new TypeError('fetch failed') }).senderAddresses(ACCOUNT)),
    ]
    for (const e of errors) {
      for (const secret of [ACCOUNT.refreshToken, ACCOUNT.clientSecret, ACCESS_TOKEN]) expect(e.message).not.toContain(secret)
    }
  })
})
