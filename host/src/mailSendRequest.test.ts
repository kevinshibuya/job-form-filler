import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppliedTexts, HostResponse, MailSendParams, MailSendResult, MailSendSent, MailSendersResult } from '@jff/shared'
import { getMailAccount, getSendAttempt, listApplied, openDb, saveMailAccount, setProfile } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'
import { log } from './log.js'
import { createMailRequests } from './mail/requests.js'
import { createFakeMailDriver, mailError, type FakeMailDriver } from '../testing/jffFakeMail/driver.mjs'
import { createFakeSecretStore, type FakeSecretStore } from '../testing/jffFakeMail/secretStore.mjs'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

/**
 * Send (spec #66, ticket #82), at the Native host's request seam: the request
 * handler called directly on an in-memory database, with the fake Mail
 * account driver and the fake secret store. A Send records its attempt before
 * the driver is called, checks the Sender address against the account's own
 * list, and on success marks the Job posting applied by email, keeps the
 * Application email with Gmail's ids, closes the attempt and records the
 * Sender address, all in one transaction.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_ID = 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com'
const CONNECTED_AT = '2026-11-19T12:00:00.000Z'

/** A Resume no table, log or reply may hold, in either form. */
const RESUME_TEXT = 'ADA-RESUME-BYTES: analytical engines, Bernoulli numbers, the Notes of 1843.'
const RESUME_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(RESUME_TEXT), Buffer.from([0, 0xff, 0x10])])
const RESUME_B64 = RESUME_BYTES.toString('base64')

const PARAMS: MailSendParams = {
  url: 'https://careers.example.com/jobs/1?utm_source=board',
  company: 'Acme',
  jobTitle: 'Analyst at Acme',
  applyAddress: 'jobs@example.org',
  senderAddress: 'ada@example.com',
  subject: 'Candidatura: Analista — São Paulo',
  body: 'Olá,\n\nGostaria de me candidatar.\n\nAtenciosamente,\nAda Lovelace',
  language: 'pt',
  resume: { name: 'Ada Lovelace - Resume.pdf', mimeType: 'application/pdf', dataBase64: RESUME_B64 },
  aiDrafted: true,
  edited: true,
  model: 'claude-opus-5-5',
  resend: false,
  abandonAttempt: null,
}

let db: Database.Database
let secrets: FakeSecretStore
let driver: FakeMailDriver
let deps: HandlerDeps
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
    mail: createMailRequests({ driver, secrets, now: () => new Date(CONNECTED_AT), timeout: () => new Promise(() => {}) }),
  }
}

/** A Mail account connected before this test, its secrets in the store. */
function connected(on: Database.Database = db): void {
  saveMailAccount(on, { kind: 'gmail', address: 'ada@example.com', clientId: CLIENT_ID, connectedAt: CONNECTED_AT })
  secrets.items.set('gmail:ada@example.com:refresh_token', 'REFRESH_TOKEN_PLACEHOLDER')
  secrets.items.set('gmail:ada@example.com:client_secret', 'CLIENT_SECRET_PLACEHOLDER')
}

beforeEach(() => {
  vi.mocked(log).mockClear()
  db = openDb(':memory:')
  secrets = createFakeSecretStore()
  driver = createFakeMailDriver({ senders: [{ address: 'ada@work.example.com', displayName: 'Ada at Work' }] })
  deps = depsOn(db)
  setProfile(db, { fullName: 'Ada Lovelace' })
  connected()
})

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function send(params: Partial<MailSendParams> = {}, requestId: string = crypto.randomUUID(), on: HandlerDeps = deps): Promise<HostResponse> {
  return handleRaw(on, { requestId, method: 'mail.send', params: { ...PARAMS, ...params } })
}

async function call(method: string, params: unknown = {}): Promise<HostResponse> {
  return handleRaw(deps, { requestId: crypto.randomUUID(), method, params })
}

const result = <T>(res: HostResponse): T => {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.kind}: ${res.error.message}`)
  return res.result as T
}

const count = (table: string, on: Database.Database = db): number =>
  (on.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

const attempts = (on: Database.Database = db): { request_id: string; state: string }[] =>
  on.prepare('SELECT request_id, state FROM send_attempts ORDER BY started_at, rowid').all() as { request_id: string; state: string }[]

function everyRow(on: Database.Database = db): string {
  const tables = on.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  return JSON.stringify(tables.map((t) => on.prepare(`SELECT * FROM ${t.name}`).all()))
}

/** Every form the Resume's bytes could take in a table, a log line or a reply. */
function holdsResume(text: string): boolean {
  return text.includes(RESUME_TEXT) || text.includes(RESUME_B64) || text.includes(RESUME_B64.slice(8, 60))
    || text.includes(RESUME_BYTES.toString('hex').slice(0, 60))
}

/* ------------------------------------------------------------------ tests */

describe('a Send that goes out', () => {
  it('hands the driver one email from the Sender address with its display name, to the Apply address, with the Resume byte for byte', async () => {
    result(await send())
    expect(driver.sent).toHaveLength(1)
    const { account, email } = driver.sent[0]!
    expect(account).toEqual({ address: 'ada@example.com', clientId: CLIENT_ID, clientSecret: 'CLIENT_SECRET_PLACEHOLDER', refreshToken: 'REFRESH_TOKEN_PLACEHOLDER' })
    expect(email.from).toEqual({ address: 'ada@example.com', displayName: 'Ada Lovelace' })
    expect(email.to).toBe('jobs@example.org')
    expect(email.subject).toBe(PARAMS.subject)
    expect(email.body).toBe(PARAMS.body)
    expect(email.attachment.name).toBe('Ada Lovelace - Resume.pdf')
    expect(email.attachment.mimeType).toBe('application/pdf')
    expect(Buffer.compare(email.attachment.data, RESUME_BYTES)).toBe(0)
  })

  it('carries the "Send mail as" entry\'s own name for that address', async () => {
    result(await send({ senderAddress: 'Ada@Work.Example.com' }))
    expect(driver.sent[0]!.email.from).toEqual({ address: 'ada@work.example.com', displayName: 'Ada at Work' })
  })

  it('leaves one Applied job by email, one Application email with both addresses and Gmail\'s two ids, and a sent attempt', async () => {
    const requestId = crypto.randomUUID()
    const out = result<MailSendSent>(await send({}, requestId))
    expect(out).toMatchObject({ outcome: 'sent', gmailMessageId: 'MESSAGE_ID_PLACEHOLDER_1', gmailThreadId: 'THREAD_ID_PLACEHOLDER_1' })

    const jobs = listApplied(db)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ id: out.appliedJobId, channel: 'email', company: 'Acme', jobTitle: 'Analyst at Acme', markedAt: out.markedAt })
    expect(jobs[0]!.canonicalUrl).toBe('careers.example.com/jobs/1')

    const texts = result<AppliedTexts>(await call('applied.get', { id: out.appliedJobId }))
    expect(texts.emails).toHaveLength(1)
    expect(texts.emails[0]).toMatchObject({
      applyAddress: 'jobs@example.org', senderAddress: 'ada@example.com',
      subject: PARAMS.subject, body: PARAMS.body, attachmentNames: ['Ada Lovelace - Resume.pdf'],
      language: 'pt', gmailMessageId: 'MESSAGE_ID_PLACEHOLDER_1', gmailThreadId: 'THREAD_ID_PLACEHOLDER_1',
      route: 'tool', aiDrafted: true, edited: true, model: 'claude-opus-5-5',
    })
    expect(Number.isNaN(Date.parse(texts.emails[0]!.sentAt))).toBe(false)

    expect(getSendAttempt(db, requestId)).toEqual({
      requestId, canonicalUrl: 'careers.example.com/jobs/1', applyAddress: 'jobs@example.org', state: 'sent',
    })
  })

  it('records the Sender address as the last used, the default of the next email Review', async () => {
    result(await send({ senderAddress: 'ada@work.example.com' }))
    expect(getMailAccount(db)?.lastSenderAddress).toBe('ada@work.example.com')
    const list = result<MailSendersResult>(await call('mail.senders'))
    expect(list.lastUsed).toBe('ada@work.example.com')
  })

  it('records the attempt as started before the driver is called', async () => {
    const requestId = crypto.randomUUID()
    const seen: unknown[] = []
    driver.onSend = () => { seen.push(getSendAttempt(db, requestId)?.state ?? 'no row') }
    result(await send({}, requestId))
    expect(seen).toEqual(['started'])
  })

  it('is never replayed from the request log', async () => {
    const requestId = crypto.randomUUID()
    result(await send({}, requestId))
    expect(count('request_log')).toBe(0)
  })

  it('leaves none of the three when the transaction fails after Gmail answered', async () => {
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON application_emails BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    const requestId = crypto.randomUUID()
    const res = await send({}, requestId)
    expect(res.ok).toBe(false)
    expect(driver.sent).toHaveLength(1)
    expect(count('applied_jobs')).toBe(0)
    expect(count('application_emails')).toBe(0)
    expect(getSendAttempt(db, requestId)?.state).not.toBe('sent')
    expect(getMailAccount(db)?.lastSenderAddress).toBeNull()
    // The email left, so the attempt is not a failure a second click may retry.
    expect(getSendAttempt(db, requestId)?.state).toBe('started')
  })

  it('leaves no Applied job when closing the attempt fails inside the same transaction', async () => {
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE OF state ON send_attempts WHEN NEW.state = 'sent' BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    const res = await send()
    expect(res.ok).toBe(false)
    expect(count('applied_jobs')).toBe(0)
    expect(count('application_emails')).toBe(0)
  })
})

describe('a Send that fails', () => {
  it('when Gmail refuses it: nothing is marked, the attempt is failed, and a second click sends', async () => {
    driver.sendFails = mailError('process', 'Gmail refused the Application email (400: Recipient address required). Nothing was sent.')
    const first = crypto.randomUUID()
    const res = await send({}, first)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.message).toContain('Recipient address required')
    expect(count('applied_jobs')).toBe(0)
    expect(count('application_emails')).toBe(0)
    expect(getSendAttempt(db, first)?.state).toBe('failed')
    expect(getMailAccount(db)?.lastSenderAddress).toBeNull()

    driver.sendFails = null
    result(await send())
    expect(driver.sent).toHaveLength(2)
    expect(count('applied_jobs')).toBe(1)
    expect(attempts().map((a) => a.state)).toEqual(['failed', 'sent'])
  })

  it('refuses a Sender address outside the account\'s list before Gmail is called', async () => {
    const requestId = crypto.randomUUID()
    const res = await send({ senderAddress: 'someone@example.net' }, requestId)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.kind).toBe('bad_request')
      expect(res.error.message).toContain('someone@example.net')
    }
    expect(driver.sent).toEqual([])
    expect(getSendAttempt(db, requestId)?.state).toBe('failed')
    expect(count('applied_jobs')).toBe(0)
  })

  it('reads the list itself: a Sender address the list no longer holds is refused', async () => {
    driver.senders = []
    const res = await send({ senderAddress: 'ada@work.example.com' })
    expect(res.ok).toBe(false)
    expect(driver.sent).toEqual([])
  })

  it('when the sign-in died: the account needs a reconnect, the attempt is failed and nothing is sent', async () => {
    driver.sendersFail = mailError('not_authed', 'Google refused the stored sign-in.')
    const requestId = crypto.randomUUID()
    const res = await send({}, requestId)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.kind).toBe('not_authed')
    expect(getMailAccount(db)?.state).toBe('needs_reconnect')
    expect(getSendAttempt(db, requestId)?.state).toBe('failed')
    expect(driver.sent).toEqual([])
  })

  it('with no Mail account: refused, and no attempt is left started', async () => {
    db.prepare('DELETE FROM mail_account').run()
    const res = await send()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.kind).toBe('bad_request')
    expect(driver.sent).toEqual([])
    expect(attempts().filter((a) => a.state === 'started')).toEqual([])
  })

  it('refuses an empty To address, subject or body before any attempt is recorded', async () => {
    for (const blank of [{ applyAddress: ' ' }, { subject: '' }, { body: '  \n ' }]) {
      const res = await send(blank)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error.kind).toBe('bad_request')
    }
    expect(count('send_attempts')).toBe(0)
    expect(driver.sent).toEqual([])
  })
})

describe('one Send at a time per Job posting and Apply address', () => {
  it('refuses a second started attempt while the first is still out, and calls nothing', async () => {
    let release!: () => void
    driver.onSend = () => new Promise<void>((ok) => { release = ok })
    const first = send()
    await vi.waitFor(() => { expect(driver.sent).toHaveLength(1) })

    // The same posting under another address of it, and the Apply address in another case.
    const second = await send({ url: 'https://careers.example.com/jobs/1', applyAddress: 'Jobs@Example.org' })
    // Ticket #83: the first attempt is still started, so the second's outcome is unknown.
    expect(result<MailSendResult>(second).outcome).toBe('unknown')
    expect(driver.sent).toHaveLength(1)

    release()
    result(await first)
    expect(count('applied_jobs')).toBe(1)
  })

  it('holds across two Native host processes on one database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jff-send-'))
    dirs.push(dir)
    const path = join(dir, 'db.sqlite')
    const a = openDb(path)
    const b = openDb(path)
    connected(a)
    setProfile(a, { fullName: 'Ada Lovelace' })
    let release!: () => void
    driver.onSend = () => new Promise<void>((ok) => { release = ok })
    const depsA = depsOn(a)
    const depsB = depsOn(b)

    const first = send({}, crypto.randomUUID(), depsA)
    await vi.waitFor(() => { expect(driver.sent).toHaveLength(1) })
    const second = await send({}, crypto.randomUUID(), depsB)
    expect(result<MailSendResult>(second).outcome).toBe('unknown')
    expect(driver.sent).toHaveLength(1)
    release()
    result(await first)
    expect(attempts(b).map((x) => x.state)).toEqual(['sent'])
    a.close()
    b.close()
  })

  it('refuses a request id already recorded, and calls nothing', async () => {
    driver.sendFails = mailError('process', 'Gmail refused the Application email (400). Nothing was sent.')
    const requestId = crypto.randomUUID()
    expect((await send({}, requestId)).ok).toBe(false)
    driver.sendFails = null
    expect((await send({}, requestId)).ok).toBe(false)
    expect(driver.sent).toHaveLength(1)
  })
})

describe('the Resume file', () => {
  it('leaves no byte in any table or any log line, on a Send that goes out and on one that fails', async () => {
    const replies: HostResponse[] = []
    replies.push(await send())
    driver.sendFails = mailError('process', 'Gmail refused the Application email (400). Nothing was sent.')
    replies.push(await send({ url: 'https://careers.example.com/jobs/2' }))
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON application_emails BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    driver.sendFails = null
    replies.push(await send({ url: 'https://careers.example.com/jobs/3' }))
    replies.push(await send({ senderAddress: 'someone@example.net', url: 'https://careers.example.com/jobs/4' }))
    // A request the schema refuses, with the file in it.
    replies.push(await send({ language: 'fr' as never, url: 'https://careers.example.com/jobs/5' }))

    expect(holdsResume(everyRow())).toBe(false)
    expect(holdsResume(JSON.stringify(vi.mocked(log).mock.calls))).toBe(false)
    expect(holdsResume(JSON.stringify(replies))).toBe(false)
  })
})

describe('the driver\'s send', () => {
  /** Every TypeScript file the Native host ships: host/src, less its tests. */
  function shipped(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return name === 'testing' ? [] : shipped(path)
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
    })
  }

  it('is called by no code path but the handler of mail.send', () => {
    const callers = shipped(here).flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      return [...text.matchAll(/\b(\w+)\.send\(/g)].map((m) => `${relative(here, path)}: ${m[1]}.send(`)
    })
    expect(callers).toEqual(['handlers.ts: mail.send(', 'mail/requests.ts: driver.send('])
    // And requests.ts calls it from `send` alone, once.
    const requests = readFileSync(resolve(here, 'mail/requests.ts'), 'utf8')
    expect(requests.match(/driver\.send\(/g)).toHaveLength(1)
    const handlers = readFileSync(resolve(here, 'handlers.ts'), 'utf8')
    expect([...handlers.matchAll(/mail\.send\(/g)]).toHaveLength(1)
    expect(handlers).toMatch(/case 'mail\.send':[\s\S]{0,200}deps\.mail\.send\(/)
  })
})
