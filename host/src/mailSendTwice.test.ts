import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AppliedTexts, HostResponse, MailSendArrivedParams, MailSendArrivedResult, MailSendParams, MailSendResult, MailSendSent, MailSendUnknown,
} from '@jff/shared'
import { getSendAttempt, listApplied, openDb, saveMailAccount, setProfile } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'
import { createMailRequests, SEND_TIMEOUT_MS } from './mail/requests.js'
import { createFakeMailDriver, mailError, type FakeMailDriver } from '../testing/fakeMailDriver.mjs'
import { createFakeSecretStore, type FakeSecretStore } from '../testing/fakeSecretStore.mjs'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

/**
 * One click never sends two emails (spec #66, ticket #83), at the Native
 * host's request seam: the request handler called directly, with the fake
 * Mail account driver. A Send whose outcome the tool cannot know leaves its
 * attempt started and answers "outcome unknown"; nothing settles that doubt
 * by sending but the user's "Send again".
 */

const CLIENT_ID = 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com'
const CONNECTED_AT = '2026-11-19T12:00:00.000Z'

const PARAMS: MailSendParams = {
  url: 'https://careers.example.com/jobs/1?utm_source=board',
  company: 'Acme',
  jobTitle: 'Analyst at Acme',
  applyAddress: 'jobs@example.org',
  senderAddress: 'ada@example.com',
  subject: 'Application: Analyst',
  body: 'Hello,\n\nI would like to apply.\n\nBest regards,\nAda Lovelace',
  language: 'en',
  resume: { name: 'Ada Lovelace - Resume.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 resume').toString('base64') },
  aiDrafted: true,
  edited: false,
  model: 'claude-opus-5-5',
  resend: false,
  abandonAttempt: null,
}

const ARRIVED = (attemptRequestId: string): MailSendArrivedParams => ({
  attemptRequestId,
  url: PARAMS.url, company: PARAMS.company, jobTitle: PARAMS.jobTitle,
  applyAddress: PARAMS.applyAddress, senderAddress: PARAMS.senderAddress,
  subject: PARAMS.subject, body: PARAMS.body, language: PARAMS.language,
  attachmentNames: ['Ada Lovelace - Resume.pdf'],
  aiDrafted: PARAMS.aiDrafted, edited: PARAMS.edited, model: PARAMS.model,
})

let db: Database.Database
let secrets: FakeSecretStore
let driver: FakeMailDriver
let deps: HandlerDeps
/** Ends the handler's wait for the driver, as its deadline passing does. */
let deadline: (() => void) | null
const dirs: string[] = []

function depsOn(database: Database.Database): HandlerDeps {
  const unused = { complete: vi.fn(async () => { throw new Error('no model call here') }) }
  return {
    db: database,
    runner: unused as unknown as HandlerDeps['runner'],
    codex: unused as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
    mail: createMailRequests({
      driver, secrets, now: () => new Date(CONNECTED_AT),
      timeout: (ms) => new Promise<void>((ok) => { if (ms === SEND_TIMEOUT_MS) deadline = ok }),
    }),
  }
}

function connected(on: Database.Database = db): void {
  saveMailAccount(on, { kind: 'gmail', address: 'ada@example.com', clientId: CLIENT_ID, connectedAt: CONNECTED_AT })
  secrets.items.set('gmail:ada@example.com:refresh_token', 'REFRESH_TOKEN_PLACEHOLDER')
  secrets.items.set('gmail:ada@example.com:client_secret', 'CLIENT_SECRET_PLACEHOLDER')
  setProfile(on, { fullName: 'Ada Lovelace' })
}

beforeEach(() => {
  db = openDb(':memory:')
  secrets = createFakeSecretStore()
  driver = createFakeMailDriver()
  deadline = null
  deps = depsOn(db)
  connected()
})

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function send(params: Partial<MailSendParams> = {}, requestId: string = crypto.randomUUID(), on: HandlerDeps = deps): Promise<HostResponse> {
  return handleRaw(on, { requestId, method: 'mail.send', params: { ...PARAMS, ...params } })
}

async function arrived(attemptRequestId: string, requestId: string = crypto.randomUUID()): Promise<HostResponse> {
  return handleRaw(deps, { requestId, method: 'mail.send.arrived', params: ARRIVED(attemptRequestId) })
}

const result = <T>(res: HostResponse): T => {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.kind}: ${res.error.message}`)
  return res.result as T
}

const sent = (res: HostResponse): MailSendSent => {
  const r = result<MailSendResult>(res)
  if (r.outcome !== 'sent') throw new Error(`expected sent, got ${JSON.stringify(r)}`)
  return r
}

const count = (table: string, on: Database.Database = db): number =>
  (on.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

const states = (on: Database.Database = db): string[] =>
  (on.prepare('SELECT state FROM send_attempts ORDER BY started_at, rowid').all() as { state: string }[]).map((a) => a.state)

/** A Send held open inside the driver until `release`. */
function holdSend(): { release: () => void } {
  const held = { release: () => {} }
  driver.onSend = () => new Promise<void>((ok) => { held.release = ok })
  return held
}

/* ------------------------------------------------------------------ tests */

describe('a response that was lost', () => {
  it('is answered again from the attempt when the same request id comes back: the driver was called once', async () => {
    const requestId = crypto.randomUUID()
    // The handler's answer is dropped on the way back: the port never reads it.
    const first = send({}, requestId)
    void first
    await vi.waitFor(() => { expect(driver.sent).toHaveLength(1) })
    await first
    const again = sent(await send({}, requestId))
    expect(driver.sent).toHaveLength(1)
    expect(again).toEqual(sent(await first))
    expect(again).toMatchObject({ outcome: 'sent', gmailMessageId: 'MESSAGE_ID_PLACEHOLDER_1', gmailThreadId: 'THREAD_ID_PLACEHOLDER_1' })
    expect(count('applied_jobs')).toBe(1)
    expect(count('application_emails')).toBe(1)
  })

  it('answers "outcome unknown" when the same request id comes back while the first is still out', async () => {
    const held = holdSend()
    const requestId = crypto.randomUUID()
    const first = send({}, requestId)
    await vi.waitFor(() => { expect(driver.sent).toHaveLength(1) })
    expect(result<MailSendResult>(await send({}, requestId))).toEqual({ outcome: 'unknown', attemptRequestId: requestId })
    held.release()
    sent(await first)
    expect(driver.sent).toHaveLength(1)
  })
})

describe('an outcome the tool cannot know', () => {
  it('a driver call that times out leaves the attempt started, marks nothing, and answers "outcome unknown"', async () => {
    driver.sendFails = mailError('timeout', 'The connection to Gmail was lost after the Application email was handed over.')
    const requestId = crypto.randomUUID()
    const out = result<MailSendResult>(await send({}, requestId))
    expect(out).toEqual({ outcome: 'unknown', attemptRequestId: requestId })
    expect(getSendAttempt(db, requestId)?.state).toBe('started')
    expect(count('applied_jobs')).toBe(0)
    expect(count('application_emails')).toBe(0)
  })

  it('a driver that never answers within the deadline is "outcome unknown", and its late success is still recorded', async () => {
    const held = holdSend()
    const requestId = crypto.randomUUID()
    const pending = send({}, requestId)
    await vi.waitFor(() => { expect(driver.sent).toHaveLength(1) })
    await vi.waitFor(() => { expect(deadline).not.toBeNull() })
    deadline!()
    expect(result<MailSendResult>(await pending)).toEqual({ outcome: 'unknown', attemptRequestId: requestId })
    expect(getSendAttempt(db, requestId)?.state).toBe('started')
    expect(count('applied_jobs')).toBe(0)

    held.release()
    await vi.waitFor(() => { expect(getSendAttempt(db, requestId)?.state).toBe('sent') })
    expect(count('applied_jobs')).toBe(1)
  })

  it('a driver that throws something other than a Mail failure is "outcome unknown" too', async () => {
    driver.sendFails = new TypeError('socket hang up')
    const requestId = crypto.randomUUID()
    expect(result<MailSendResult>(await send({}, requestId))).toEqual({ outcome: 'unknown', attemptRequestId: requestId })
    expect(getSendAttempt(db, requestId)?.state).toBe('started')
  })

  it('a Send that finds a started attempt for its Job posting and Apply address answers "outcome unknown" and calls nothing', async () => {
    driver.sendFails = mailError('timeout', 'lost')
    const first = crypto.randomUUID()
    result(await send({}, first))
    driver.sendFails = null
    const callsBefore = driver.senderCalls.length

    // Another click, under another address of the same posting and the Apply address in another case.
    const out = result<MailSendResult>(await send({ url: 'https://careers.example.com/jobs/1', applyAddress: ' Jobs@Example.org ' }))
    expect(out).toEqual({ outcome: 'unknown', attemptRequestId: first })
    expect(driver.sent).toHaveLength(1)
    expect(driver.senderCalls.length).toBe(callsBefore)
    expect(states()).toEqual(['started'])
  })

  it('"outcome unknown" holds even with the user\'s choice to send again, until that attempt is abandoned', async () => {
    driver.sendFails = mailError('timeout', 'lost')
    const first = crypto.randomUUID()
    result(await send({}, first))
    driver.sendFails = null
    expect(result<MailSendResult>(await send({ resend: true }))).toEqual({ outcome: 'unknown', attemptRequestId: first })
    expect(driver.sent).toHaveLength(1)
  })
})

describe('two Native host processes on one database file', () => {
  it('cannot both start an attempt for the same Job posting and Apply address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jff-send-twice-'))
    dirs.push(dir)
    const path = join(dir, 'db.sqlite')
    const a = openDb(path)
    const b = openDb(path)
    connected(a)
    const held = holdSend()
    const firstId = crypto.randomUUID()

    const first = send({}, firstId, depsOn(a))
    await vi.waitFor(() => { expect(driver.sent).toHaveLength(1) })
    const second = result<MailSendResult>(await send({ resend: true }, crypto.randomUUID(), depsOn(b)))
    expect(second).toEqual({ outcome: 'unknown', attemptRequestId: firstId })
    expect(driver.sent).toHaveLength(1)

    held.release()
    sent(await first)
    expect(states(b)).toEqual(['sent'])
    a.close()
    b.close()
  })
})

describe('"It arrived"', () => {
  it('leaves an Applied job by email and an Application email with no Gmail ids, and the attempt is no longer started', async () => {
    driver.sendFails = mailError('timeout', 'lost')
    const attempt = crypto.randomUUID()
    result(await send({}, attempt))

    const out = result<MailSendArrivedResult>(await arrived(attempt))
    const jobs = listApplied(db)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ id: out.appliedJobId, channel: 'email', markedAt: out.markedAt })
    const texts = result<AppliedTexts>(await handleRaw(deps, { requestId: crypto.randomUUID(), method: 'applied.get', params: { id: out.appliedJobId } }))
    expect(texts.emails).toHaveLength(1)
    expect(texts.emails[0]).toMatchObject({
      applyAddress: 'jobs@example.org', senderAddress: 'ada@example.com', subject: PARAMS.subject, body: PARAMS.body,
      attachmentNames: ['Ada Lovelace - Resume.pdf'], gmailMessageId: null, gmailThreadId: null, route: 'tool',
    })
    expect(getSendAttempt(db, attempt)?.state).not.toBe('started')
    expect(driver.sent).toHaveLength(1)
  })

  it('asked again records nothing twice', async () => {
    driver.sendFails = mailError('timeout', 'lost')
    const attempt = crypto.randomUUID()
    result(await send({}, attempt))
    const requestId = crypto.randomUUID()
    const once = result<MailSendArrivedResult>(await arrived(attempt, requestId))
    expect(result<MailSendArrivedResult>(await arrived(attempt, requestId))).toEqual(once)
    expect(count('application_emails')).toBe(1)
  })

  it('then a new Send to the same address is refused without the user\'s choice', async () => {
    driver.sendFails = mailError('timeout', 'lost')
    const attempt = crypto.randomUUID()
    result(await send({}, attempt))
    result(await arrived(attempt))
    driver.sendFails = null
    expect((await send()).ok).toBe(false)
    expect(driver.sent).toHaveLength(1)
  })
})

describe('"Send again"', () => {
  it('sets the old attempt to abandoned and calls the driver once more', async () => {
    driver.sendFails = mailError('timeout', 'lost')
    const old = crypto.randomUUID()
    result(await send({}, old))
    driver.sendFails = null

    const again = crypto.randomUUID()
    const out = sent(await send({ resend: true, abandonAttempt: old }, again))
    expect(getSendAttempt(db, old)?.state).toBe('abandoned')
    expect(getSendAttempt(db, again)?.state).toBe('sent')
    expect(driver.sent).toHaveLength(2)
    expect(listApplied(db)[0]).toMatchObject({ id: out.appliedJobId, channel: 'email' })
  })
})

describe('a Job posting and Apply address that already have a sent attempt', () => {
  it('refuses a Send without the user\'s choice, and sends with it', async () => {
    sent(await send())
    const refused = await send({ url: 'https://careers.example.com/jobs/1#apply', applyAddress: 'JOBS@example.org' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error.kind).toBe('bad_request')
      expect(refused.error.message).toContain('jobs@example.org')
    }
    expect(driver.sent).toHaveLength(1)

    sent(await send({ resend: true }))
    expect(driver.sent).toHaveLength(2)
    expect(count('application_emails')).toBe(2)
    expect(count('applied_jobs')).toBe(1)
  })

  it('sends to another Apply address of the same posting without the choice', async () => {
    sent(await send())
    sent(await send({ applyAddress: 'hiring@example.org' }))
    expect(driver.sent).toHaveLength(2)
  })
})

describe('a failure Gmail states', () => {
  it('is still failed, marks nothing, and a second click sends', async () => {
    driver.sendFails = mailError('process', 'Gmail refused the Application email (400: Recipient address required). Nothing was sent.')
    const first = crypto.randomUUID()
    const res = await send({}, first)
    expect(res.ok).toBe(false)
    expect(getSendAttempt(db, first)?.state).toBe('failed')
    expect(count('applied_jobs')).toBe(0)

    driver.sendFails = null
    sent(await send())
    expect(driver.sent).toHaveLength(2)
    expect(states()).toEqual(['failed', 'sent'])
  })
})

// Unused import guard: the unknown shape is the one the panel reads.
const _unknown: MailSendUnknown = { outcome: 'unknown', attemptRequestId: 'x' }
void _unknown
