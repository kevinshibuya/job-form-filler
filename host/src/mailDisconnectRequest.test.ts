import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { HostResponse, MailDisconnectResult, MailStatus } from '@jff/shared'
import { getMailAccount, openDb } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'
import { log } from './log.js'
import { MailError } from './mail/account.js'
import { createGmailDriver } from './mail/gmail.js'
import type { HttpRequest, HttpResponse } from './mail/net.js'
import { createMailRequests } from './mail/requests.js'
import { createFakeMailDriver, type FakeMailDriver } from '../testing/fakeMailDriver.mjs'
import { createFakeSecretStore, type FakeSecretStore } from '../testing/fakeSecretStore.mjs'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

/**
 * Disconnect the Mail account (spec #66, ticket #80), at the Native host's
 * request seam: an in-memory database, the request handler called directly,
 * the fake Mail account driver and the fake secret store. Then the Gmail
 * driver's revoke call, with the network call injected.
 */

const REFRESH = 'REFRESH_TOKEN_PLACEHOLDER'
const SECRET = 'CLIENT_SECRET_PLACEHOLDER'
const CLIENT_FILE = JSON.stringify({ installed: { client_id: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com', client_secret: SECRET } })
const NOW = new Date('2026-11-19T12:00:00.000Z')

let db: Database.Database
let driver: FakeMailDriver
let secrets: FakeSecretStore
let deps: HandlerDeps

beforeEach(() => {
  vi.mocked(log).mockClear()
  db = openDb(':memory:')
  secrets = createFakeSecretStore()
  driver = createFakeMailDriver()
  const unused = { complete: vi.fn(async () => { throw new Error('no model call here') }) }
  deps = {
    db,
    runner: unused as unknown as HandlerDeps['runner'],
    codex: unused as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
    mail: createMailRequests({ driver, secrets, now: () => NOW, timeout: () => new Promise<void>(() => {}) }),
  }
})

async function call(method: string, params: unknown = {}): Promise<HostResponse> {
  return handleRaw(deps, { requestId: crypto.randomUUID(), method, params })
}

const result = <T>(res: HostResponse): T => {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.kind}: ${res.error.message}`)
  return res.result as T
}

/** The fake driver's sign-in returns at once: Connect is its two requests. */
async function connect(): Promise<MailStatus> {
  result(await call('mail.connect.start', { clientFile: CLIENT_FILE }))
  return result<MailStatus>(await call('mail.connect.finish'))
}

describe('mail.disconnect', () => {
  it('revokes the refresh token at Google, removes the account\'s row and leaves the secret store empty', async () => {
    expect(await connect()).toMatchObject({ state: 'connected' })
    expect(secrets.items.size).toBe(2)

    const res = result<MailDisconnectResult>(await call('mail.disconnect'))

    expect(res).toEqual({ revoked: true, warning: null })
    expect(driver.revoked).toEqual([REFRESH])
    expect(getMailAccount(db)).toBeNull()
    expect(secrets.items.size).toBe(0)
  })

  it('with Google out of reach, still removes the row and both secrets, and says the token could not be revoked', async () => {
    await connect()
    driver.revokeFails = new MailError('process', 'Could not reach Google: getaddrinfo ENOTFOUND oauth2.googleapis.com')

    const res = result<MailDisconnectResult>(await call('mail.disconnect'))

    expect(res.revoked).toBe(false)
    expect(res.warning).toMatch(/could not be revoked at Google/)
    expect(driver.revoked).toEqual([REFRESH])
    expect(getMailAccount(db)).toBeNull()
    expect(secrets.items.size).toBe(0)
  })

  it('a revoke that throws something other than a MailError does not stop it either', async () => {
    await connect()
    driver.revokeFails = new TypeError('fetch failed')
    const res = result<MailDisconnectResult>(await call('mail.disconnect'))
    expect(res.revoked).toBe(false)
    expect(getMailAccount(db)).toBeNull()
    expect(secrets.items.size).toBe(0)
  })

  it('after it, mail.status reports no account', async () => {
    await connect()
    result(await call('mail.disconnect'))
    expect(result<MailStatus>(await call('mail.status'))).toEqual({ state: 'none' })
  })

  it('an account that needs a reconnect disconnects the same way', async () => {
    await connect()
    db.prepare("UPDATE mail_account SET state = 'needs_reconnect'").run()
    driver.revokeFails = new MailError('not_authed', 'Google refused the revoke (400 invalid_token).')
    const res = result<MailDisconnectResult>(await call('mail.disconnect'))
    expect(res.revoked).toBe(false)
    expect(getMailAccount(db)).toBeNull()
    expect(secrets.items.size).toBe(0)
  })

  it('with no refresh token in the store, revokes nothing and still forgets the account', async () => {
    await connect()
    secrets.items.delete('gmail:ada@example.com:refresh_token')
    const res = result<MailDisconnectResult>(await call('mail.disconnect'))
    expect(driver.revoked).toEqual([])
    expect(res).toEqual({ revoked: false, warning: expect.stringMatching(/could not be revoked at Google/) })
    expect(getMailAccount(db)).toBeNull()
    expect(secrets.items.size).toBe(0)
  })

  it('with no account, does nothing and says there was nothing to revoke', async () => {
    const res = result<MailDisconnectResult>(await call('mail.disconnect'))
    expect(res).toEqual({ revoked: false, warning: null })
    expect(driver.revoked).toEqual([])
  })

  it('a new Connect works after it', async () => {
    await connect()
    result(await call('mail.disconnect'))
    expect(await connect()).toEqual({ state: 'connected', kind: 'gmail', address: 'ada@example.com', connectedAt: NOW.toISOString() })
    expect(secrets.items.size).toBe(2)
  })

  it('puts no secret in its response or the log', async () => {
    await connect()
    driver.revokeFails = new MailError('process', 'Could not reach Google.')
    const res = await call('mail.disconnect')
    for (const s of [REFRESH, SECRET]) {
      expect(JSON.stringify(res)).not.toContain(s)
      expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(s)
    }
  })

  it('is never replayed: a second one with the same request id runs again', async () => {
    await connect()
    result(await handleRaw(deps, { requestId: 'same-id', method: 'mail.disconnect', params: {} }))
    await connect()
    result(await handleRaw(deps, { requestId: 'same-id', method: 'mail.disconnect', params: {} }))
    expect(driver.revoked).toEqual([REFRESH, REFRESH])
    expect(getMailAccount(db)).toBeNull()
  })
})

describe('the Gmail driver\'s revoke', () => {
  /** The network, answering every call with this response. */
  function network(response: HttpResponse | Error): { calls: HttpRequest[]; http: (req: HttpRequest) => Promise<HttpResponse> } {
    const calls: HttpRequest[] = []
    return {
      calls,
      http: async (req) => {
        calls.push(req)
        if (response instanceof Error) throw response
        return response
      },
    }
  }

  it('posts the refresh token to Google\'s revoke endpoint, as the research document recorded', async () => {
    const net = network({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' })
    await createGmailDriver({ http: net.http }).revoke(REFRESH)
    expect(net.calls).toEqual([{
      method: 'POST', url: 'https://oauth2.googleapis.com/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${REFRESH}`,
    }])
  })

  it('a refusal from Google is a MailError that names the status and the error', async () => {
    const net = network({ status: 400, headers: {}, body: '{"error": "invalid_token", "error_description": "Token expired or revoked"}' })
    const err = await createGmailDriver({ http: net.http }).revoke(REFRESH).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailError)
    expect((err as Error).message).toMatch(/400 invalid_token/)
    expect((err as Error).message).not.toContain(REFRESH)
  })

  it('Google out of reach is a MailError of kind process', async () => {
    const net = network(new TypeError('fetch failed'))
    const err = await createGmailDriver({ http: net.http }).revoke(REFRESH).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailError)
    expect((err as MailError).kind).toBe('process')
    expect((err as Error).message).toMatch(/Could not reach Google/)
  })
})
