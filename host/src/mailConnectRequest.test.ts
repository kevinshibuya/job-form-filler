import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { HostResponse, MailStatus } from '@jff/shared'
import { getMailAccount, openDb } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'
import { log } from './log.js'
import { CONNECT_TIMEOUT_MS, createMailRequests } from './mail/requests.js'
import { createFakeMailDriver, type FakeMailDriver } from '../testing/jffFakeMail/driver.mjs'
import { createFakeSecretStore, type FakeSecretStore } from '../testing/jffFakeMail/secretStore.mjs'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

/**
 * Connect a Gmail Mail account (spec #66, ticket #79), at the Native host's
 * request seam: an in-memory database, the request handler called directly,
 * the fake Mail account driver and the fake secret store. The clock that ends
 * a sign-in which never returns is the test's.
 */

const REFRESH = 'REFRESH_TOKEN_PLACEHOLDER'
const SECRET = 'CLIENT_SECRET_PLACEHOLDER'
const CLIENT_FILE = JSON.stringify({ installed: { client_id: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com', client_secret: SECRET } })
const NOW = new Date('2026-11-19T12:00:00.000Z')

let db: Database.Database
let driver: FakeMailDriver
let secrets: FakeSecretStore
let deps: HandlerDeps
/** The test's clock: each wait the handler asked for, which the test ends. */
let waits: { ms: number; end: () => void }[]
const responses: HostResponse[] = []

function build(d: FakeMailDriver): void {
  driver = d
  deps = { ...deps, mail: createMailRequests({
    driver, secrets, now: () => NOW,
    timeout: (ms) => new Promise<void>((end) => { waits.push({ ms, end }) }),
  }) }
}

beforeEach(() => {
  vi.mocked(log).mockClear()
  responses.length = 0
  waits = []
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
  build(createFakeMailDriver({ signIn: 'manual' }))
})

async function call(method: string, params: unknown = {}, requestId = crypto.randomUUID()): Promise<HostResponse> {
  const res = await handleRaw(deps, { requestId, method, params })
  responses.push(res)
  return res
}

const result = <T>(res: HostResponse): T => {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.kind}: ${res.error.message}`)
  return res.result as T
}

/** Settles with the response, or with 'still waiting' once the handler has
 *  had time to answer and has not. */
async function within<T>(p: Promise<T>, ms = 1_000): Promise<T | 'still waiting'> {
  return Promise.race([p, new Promise<'still waiting'>((ok) => setTimeout(() => ok('still waiting'), ms))])
}

/** Every row of every table, as text. */
function everyRow(): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  return JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM ${t.name}`).all()))
}

async function connect(): Promise<HostResponse> {
  result(await call('mail.connect.start', { clientFile: CLIENT_FILE }))
  const finish = call('mail.connect.finish')
  await vi.waitFor(() => expect(waits).toHaveLength(1))
  driver.returnSignIn()
  return finish
}

describe('mail.connect.start', () => {
  it('hands the dropped client file to the driver and answers the consent address', async () => {
    const res = result<{ consentUrl: string }>(await call('mail.connect.start', { clientFile: CLIENT_FILE }))
    expect(res.consentUrl).toMatch(/^https:\/\/accounts\.google\.com\//)
    expect(driver.clientFiles).toEqual([CLIENT_FILE])
  })

  it('answers the driver\'s refusal of a client file of another type with its message', async () => {
    build(createFakeMailDriver({ refuseClientFile: 'This is not the client file of a Desktop app.' }))
    const res = await call('mail.connect.start', { clientFile: '{"web": {}}' })
    expect(res).toMatchObject({ ok: false, error: { kind: 'bad_request', message: 'This is not the client file of a Desktop app.' } })
    expect(result<MailStatus>(await call('mail.status'))).toEqual({ state: 'none' })
  })

  it('a second Connect stops the first sign-in', async () => {
    await call('mail.connect.start', { clientFile: CLIENT_FILE })
    await call('mail.connect.start', { clientFile: CLIENT_FILE })
    expect(driver.cancelled).toBe(1)
  })
})

describe('mail.connect.finish', () => {
  it('waits for the sign-in, then answers the account\'s address and keeps it', async () => {
    const res = await connect()
    expect(result<MailStatus>(res)).toEqual({ state: 'connected', kind: 'gmail', address: 'ada@example.com', connectedAt: NOW.toISOString() })
    expect(getMailAccount(db)).toEqual({
      kind: 'gmail', address: 'ada@example.com', clientId: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com',
      connectedAt: NOW.toISOString(), state: 'connected', lastSenderAddress: null,
    })
  })

  it('puts the refresh token and the client secret in the secret store, and in no row, log line or response', async () => {
    await connect()
    expect(Object.fromEntries(secrets.items)).toEqual({
      'gmail:ada@example.com:refresh_token': REFRESH,
      'gmail:ada@example.com:client_secret': SECRET,
    })
    await call('mail.status')
    for (const secret of [REFRESH, SECRET]) {
      expect(everyRow()).not.toContain(secret)
      expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain(secret)
      expect(JSON.stringify(responses)).not.toContain(secret)
    }
  })

  it('ends a sign-in that never returns with a timeout, and connects nothing', async () => {
    build(createFakeMailDriver({ signIn: 'never' }))
    await call('mail.connect.start', { clientFile: CLIENT_FILE })
    const finish = call('mail.connect.finish')
    await vi.waitFor(() => expect(waits).toHaveLength(1))
    expect(waits[0]!.ms).toBe(CONNECT_TIMEOUT_MS)
    waits[0]!.end()
    const res = await within(finish)
    expect(res).toMatchObject({ ok: false, error: { kind: 'timeout' } })
    expect(driver.cancelled).toBe(1)
    expect(getMailAccount(db)).toBeNull()
    expect(secrets.items.size).toBe(0)
  })

  it('the timeout is minutes long, not the port\'s ten-minute deadline', () => {
    expect(CONNECT_TIMEOUT_MS).toBe(5 * 60_000)
  })

  it('connects nothing when the sign-in comes back refused, as a wrong state does', async () => {
    await call('mail.connect.start', { clientFile: CLIENT_FILE })
    const finish = call('mail.connect.finish')
    await vi.waitFor(() => expect(waits).toHaveLength(1))
    driver.refuseSignIn('bad_request', 'The sign-in came back with a state that does not match the one sent.')
    expect(await finish).toMatchObject({ ok: false, error: { kind: 'bad_request', message: expect.stringMatching(/state/) } })
    expect(getMailAccount(db)).toBeNull()
    expect(secrets.items.size).toBe(0)
    expect(result<MailStatus>(await call('mail.status'))).toEqual({ state: 'none' })
  })

  it('with no sign-in started, says to click Connect', async () => {
    const res = await call('mail.connect.finish')
    expect(res).toMatchObject({ ok: false, error: { kind: 'bad_request', message: expect.stringMatching(/Connect/) } })
  })

  it('a sign-in is finished once: a second finish finds none', async () => {
    await connect()
    expect(await call('mail.connect.finish')).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
  })
})

describe('mail.status', () => {
  it('reports no account before Connect and the address and date after it', async () => {
    expect(result<MailStatus>(await call('mail.status'))).toEqual({ state: 'none' })
    await connect()
    expect(result<MailStatus>(await call('mail.status'))).toEqual({
      state: 'connected', kind: 'gmail', address: 'ada@example.com', connectedAt: NOW.toISOString(),
    })
  })

  it('reports an account whose sign-in died as needing a reconnect', async () => {
    await connect()
    db.prepare("UPDATE mail_account SET state = 'needs_reconnect'").run()
    expect(result<MailStatus>(await call('mail.status'))).toEqual({
      state: 'needs_reconnect', kind: 'gmail', address: 'ada@example.com', connectedAt: NOW.toISOString(),
    })
  })
})

describe('no mail. request is replayed', () => {
  it('a mail. request repeated with the same request id runs again', async () => {
    expect(result<MailStatus>(await call('mail.status', {}, 'same-id'))).toEqual({ state: 'none' })
    await connect()
    expect(result<MailStatus>(await call('mail.status', {}, 'same-id'))).toMatchObject({ state: 'connected' })
    expect(db.prepare("SELECT COUNT(*) AS n FROM request_log WHERE request_id = 'same-id'").get()).toEqual({ n: 0 })
  })

  it('mail.connect.start repeated with the same request id starts a new sign-in', async () => {
    await call('mail.connect.start', { clientFile: CLIENT_FILE }, 'start-id')
    await call('mail.connect.start', { clientFile: CLIENT_FILE }, 'start-id')
    expect(driver.clientFiles).toHaveLength(2)
  })

  it('other requests are still replayed', async () => {
    await call('profile.set', { values: { firstName: 'Ada' } }, 'profile-id')
    expect(db.prepare("SELECT COUNT(*) AS n FROM request_log WHERE request_id = 'profile-id'").get()).toEqual({ n: 1 })
  })
})
