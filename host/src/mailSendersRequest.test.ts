import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostResponse, MailSendersResult, MailStatus } from '@jff/shared'
import { getMailAccount, openDb, saveMailAccount, setProfile } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'
import { log } from './log.js'
import type { MailAccountDriver } from './mail/account.js'
import { createGmailDriver } from './mail/gmail.js'
import type { HttpRequest, HttpResponse } from './mail/net.js'
import { createMailRequests } from './mail/requests.js'
import { createFakeMailDriver, mailError, type FakeMailDriver } from '../testing/jffFakeMail/driver.mjs'
import { createFakeSecretStore, type FakeSecretStore } from '../testing/jffFakeMail/secretStore.mjs'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

/**
 * The Sender addresses and Reconnect (spec #66, ticket #81), at the Native
 * host's request seam: an in-memory database, the request handler called
 * directly, the fake secret store, and either the fake Mail account driver or
 * the Gmail driver on the research ticket's recorded transcripts.
 */

const here = dirname(fileURLToPath(import.meta.url))
interface Transcript { request: HttpRequest; response: HttpResponse }
const transcript = (name: string): Transcript =>
  JSON.parse(readFileSync(resolve(here, '../../e2e/fixtures/gmail', name), 'utf8')) as Transcript

const CLIENT_ID = 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com'
const REFRESH = 'REFRESH_TOKEN_PLACEHOLDER'
const SECRET = 'CLIENT_SECRET_PLACEHOLDER'
const ACCESS = 'ACCESS_TOKEN_PLACEHOLDER'
const CONNECTED_AT = '2026-11-19T12:00:00.000Z'

let db: Database.Database
let secrets: FakeSecretStore
let deps: HandlerDeps
const responses: HostResponse[] = []

function useDriver(driver: MailAccountDriver): void {
  deps = { ...deps, mail: createMailRequests({ driver, secrets, now: () => new Date(CONNECTED_AT), timeout: () => new Promise(() => {}) }) }
}

/** The Gmail driver, its network answered from the recordings. */
function gmailOn(refresh: string, network?: () => never): { calls: HttpRequest[]; driver: MailAccountDriver } {
  const calls: HttpRequest[] = []
  const answers: Record<string, Transcript> = {
    'https://oauth2.googleapis.com/token': transcript(refresh),
    'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs': transcript('send-as-list.json'),
  }
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req)
    if (network !== undefined) network()
    return answers[req.url]!.response
  }
  return { calls, driver: createGmailDriver({ http, senderAddresses: 'dropdown' }) }
}

/** A Mail account connected before this test, its secrets in the store. */
function connected(lastSender: string | null = null): void {
  saveMailAccount(db, { kind: 'gmail', address: 'ada@example.com', clientId: CLIENT_ID, connectedAt: CONNECTED_AT })
  if (lastSender !== null) db.prepare('UPDATE mail_account SET last_sender_address = ?').run(lastSender)
  secrets.items.set('gmail:ada@example.com:refresh_token', REFRESH)
  secrets.items.set('gmail:ada@example.com:client_secret', SECRET)
}

beforeEach(() => {
  vi.mocked(log).mockClear()
  responses.length = 0
  db = openDb(':memory:')
  secrets = createFakeSecretStore()
  const unused = { complete: vi.fn(async () => { throw new Error('no model call here') }) }
  deps = {
    db,
    runner: unused as unknown as HandlerDeps['runner'],
    codex: unused as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
  setProfile(db, { fullName: 'Ada Lovelace' })
  useDriver(createFakeMailDriver())
})

async function call(method: string, params: unknown = {}): Promise<HostResponse> {
  const res = await handleRaw(deps, { requestId: crypto.randomUUID(), method, params })
  responses.push(res)
  return res
}

const result = <T>(res: HostResponse): T => {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.kind}: ${res.error.message}`)
  return res.result as T
}

const state = (): string | undefined => getMailAccount(db)?.state

function everyRow(): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  return JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM ${t.name}`).all()))
}

describe('mail.senders', () => {
  it('lists the own address and each verified "Send mail as" address, and no unverified one', async () => {
    connected()
    useDriver(gmailOn('token-refresh.json').driver)
    const res = result<MailSendersResult>(await call('mail.senders'))
    expect(res.senders.map((s) => s.address)).toEqual(['ada@example.com', 'ada@work.example.com'])
    expect(res.address).toBe('ada@example.com')
  })

  it('an entry with a name keeps it, and one without gets the Profile name', async () => {
    connected()
    setProfile(db, { fullName: 'Augusta Ada King' })
    useDriver(gmailOn('token-refresh.json').driver)
    const res = result<MailSendersResult>(await call('mail.senders'))
    expect(res.senders).toEqual([
      { address: 'ada@example.com', displayName: 'Augusta Ada King' },
      { address: 'ada@work.example.com', displayName: 'Ada Lovelace' },
    ])
  })

  it('with no Profile name, an entry without a name has an empty one', async () => {
    setProfile(db, { fullName: '' })
    connected()
    const res = result<MailSendersResult>(await call('mail.senders'))
    expect(res.senders).toEqual([{ address: 'ada@example.com', displayName: '' }])
  })

  it('answers the last used Sender address the database holds', async () => {
    connected('ada@work.example.com')
    expect(result<MailSendersResult>(await call('mail.senders')).lastUsed).toBe('ada@work.example.com')
  })

  it('hands the driver the stored client and refresh token', async () => {
    const driver: FakeMailDriver = createFakeMailDriver()
    useDriver(driver)
    connected()
    await call('mail.senders')
    expect(driver.senderCalls).toEqual([{ address: 'ada@example.com', clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH }])
  })

  it('with no Mail account, says to connect one and calls nothing', async () => {
    const driver = createFakeMailDriver()
    useDriver(driver)
    const res = await call('mail.senders')
    expect(res).toMatchObject({ ok: false, error: { kind: 'bad_request', message: expect.stringMatching(/Connect/) } })
    expect(driver.senderCalls).toEqual([])
  })
})

describe('a sign-in that died', () => {
  it('a refresh refused with invalid_grant sets the state to "needs reconnect"', async () => {
    connected()
    useDriver(gmailOn('refresh-invalid-grant.json').driver)
    const res = await call('mail.senders')
    expect(res).toMatchObject({ ok: false, error: { kind: 'not_authed' } })
    expect(state()).toBe('needs_reconnect')
    expect(result<MailStatus>(await call('mail.status'))).toMatchObject({ state: 'needs_reconnect', address: 'ada@example.com' })
  })

  it('a network failure leaves the state connected', async () => {
    connected()
    useDriver(gmailOn('token-refresh.json', () => { throw new TypeError('fetch failed') }).driver)
    const res = await call('mail.senders')
    expect(res.ok).toBe(false)
    expect(state()).toBe('connected')
  })

  it('a failure of another kind from the driver leaves the state connected', async () => {
    connected()
    const driver = createFakeMailDriver()
    driver.sendersFail = mailError('process', 'Gmail did not list the "Send mail as" addresses (500).')
    useDriver(driver)
    expect((await call('mail.senders')).ok).toBe(false)
    expect(state()).toBe('connected')
  })

  it('with the state "needs reconnect", answers not_authed and asks Google nothing', async () => {
    connected()
    db.prepare("UPDATE mail_account SET state = 'needs_reconnect'").run()
    const driver = createFakeMailDriver()
    useDriver(driver)
    expect(await call('mail.senders')).toMatchObject({ ok: false, error: { kind: 'not_authed', message: expect.stringMatching(/Reconnect/) } })
    expect(driver.senderCalls).toEqual([])
  })

  it('a refresh token missing from the secret store needs a reconnect too', async () => {
    connected()
    secrets.items.delete('gmail:ada@example.com:refresh_token')
    expect(await call('mail.senders')).toMatchObject({ ok: false, error: { kind: 'not_authed' } })
    expect(state()).toBe('needs_reconnect')
  })
})

describe('Reconnect: mail.connect.start with no client file', () => {
  it('starts a sign-in with the stored client', async () => {
    connected()
    db.prepare("UPDATE mail_account SET state = 'needs_reconnect'").run()
    const driver = createFakeMailDriver({ signIn: 'manual' })
    useDriver(driver)
    const res = result<{ consentUrl: string }>(await call('mail.connect.start', {}))
    expect(res.consentUrl).toMatch(/^https:\/\/accounts\.google\.com\//)
    expect(driver.clientFiles).toEqual([])
    expect(driver.storedClients).toEqual([{ clientId: CLIENT_ID, clientSecret: SECRET }])
  })

  it('a finished one returns the state to connected and keeps the last used Sender address', async () => {
    connected('ada@work.example.com')
    db.prepare("UPDATE mail_account SET state = 'needs_reconnect'").run()
    const driver = createFakeMailDriver({ signIn: 'manual', account: { refreshToken: 'REFRESH_TOKEN_PLACEHOLDER_2' } })
    useDriver(driver)
    await call('mail.connect.start', {})
    const finish = call('mail.connect.finish')
    driver.returnSignIn()
    expect(result<MailStatus>(await finish)).toMatchObject({ state: 'connected', address: 'ada@example.com' })
    expect(getMailAccount(db)).toMatchObject({ state: 'connected', lastSenderAddress: 'ada@work.example.com' })
    expect(secrets.items.get('gmail:ada@example.com:refresh_token')).toBe('REFRESH_TOKEN_PLACEHOLDER_2')
  })

  it('with no Mail account, says to drop the client file and starts nothing', async () => {
    const driver = createFakeMailDriver({ signIn: 'manual' })
    useDriver(driver)
    expect(await call('mail.connect.start', {})).toMatchObject({ ok: false, error: { kind: 'bad_request', message: expect.stringMatching(/client file/) } })
    expect(driver.storedClients).toEqual([])
  })

  it('with the client secret gone from the secret store, says to drop the client file', async () => {
    connected()
    secrets.items.delete('gmail:ada@example.com:client_secret')
    const driver = createFakeMailDriver({ signIn: 'manual' })
    useDriver(driver)
    expect(await call('mail.connect.start', {})).toMatchObject({ ok: false, error: { kind: 'bad_request', message: expect.stringMatching(/client file/) } })
    expect(driver.storedClients).toEqual([])
  })

  it('a client file still starts a sign-in from that file', async () => {
    connected()
    const driver = createFakeMailDriver({ signIn: 'manual' })
    useDriver(driver)
    const file = JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: SECRET } })
    await call('mail.connect.start', { clientFile: file })
    expect(driver.clientFiles).toEqual([file])
    expect(driver.storedClients).toEqual([])
  })
})

describe('no access token is kept or answered', () => {
  it('is in no row, no log line and no response', async () => {
    connected()
    useDriver(gmailOn('token-refresh.json').driver)
    await call('mail.senders')
    await call('mail.senders')
    useDriver(gmailOn('refresh-invalid-grant.json').driver)
    await call('mail.senders')
    expect(responses.some((r) => r.ok)).toBe(true)
    for (const secret of [ACCESS, REFRESH, SECRET]) {
      expect(everyRow()).not.toContain(secret)
      expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(secret)
      expect(JSON.stringify(responses)).not.toContain(secret)
    }
  })
})
