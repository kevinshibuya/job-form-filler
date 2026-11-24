import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import DatabaseCtor from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { DatabaseTooNew, MIGRATIONS, type Migration } from './migrations.js'
import { getMailAccount, getProfile, listApplicationEmails, listApplied, listKeptProseAnswers, markApplied, openDb, recordArrivedEmail, saveMailAccount, setProfile } from './repos.js'
import { SCHEMA_SQL } from './schema.js'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('../log.js', () => ({ log: vi.fn() }))

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '../../..')
const VITE_NODE = join(REPO, 'node_modules/vite-node/vite-node.mjs')
const RACE_CHILD = resolve(here, '../testing/openDbChild.ts')
const BETTER_SQLITE = createRequire(import.meta.url).resolve('better-sqlite3')

const dirs: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jff-migrations-'))
  dirs.push(dir)
  return join(dir, 'db.sqlite')
}

/** A database file in the shape every Native host before versioning left
 *  behind: today's schema, WAL, user_version 0, with rows in it. */
function oldShapeDb(path: string): void {
  const db = new DatabaseCtor(path)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  db.prepare("INSERT INTO profile (key, value) VALUES ('email', 'ada@example.com'), ('firstName', 'Ada')").run()
  db.prepare("INSERT INTO answer_bank (key, value) VALUES ('salary', 'R$ 18.000/mo')").run()
  db.prepare(`INSERT INTO qa_memory (question_normalized, question_raw, answer, language, reusability)
              VALUES ('why us', 'Why us?', 'Because', 'en', 'reusable')`).run()
  db.prepare(`INSERT INTO applied_jobs (url, canonical_url, company, job_title, marked_at)
              VALUES ('https://jobs.example.com/1?utm=x', 'https://jobs.example.com/1', 'Acme', 'Engineer', '2026-11-01T00:00:00Z')`).run()
  db.prepare("INSERT INTO request_log (request_id, response_json, created_at) VALUES ('r1', '{}', ?)").run(new Date().toISOString())
  db.close()
}

function rowsOf(db: Database.Database): Record<string, unknown[]> {
  const tables = ['profile', 'answer_bank', 'qa_memory', 'applied_jobs', 'request_log']
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))
}

const version = (db: Database.Database): number => db.pragma('user_version', { simple: true }) as number

function shapeOf(db: Database.Database): { name: string; sql: string }[] {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[]
}

/** A migration that fails when applied a second time to the same file. */
const addProbeColumn = (onApply?: () => void): Migration => ({
  version: MIGRATIONS.length + 1,
  name: 'test: add a column, which fails the second time',
  up: (db) => { onApply?.(); db.exec('ALTER TABLE profile ADD COLUMN probe TEXT') },
})

describe('openDb migrations', () => {
  it('gives a database in the pre-versioning shape a schema version and keeps every row', () => {
    const path = tempDbPath()
    oldShapeDb(path)
    const before = new DatabaseCtor(path, { readonly: true })
    const rows = rowsOf(before)
    before.close()

    const db = openDb(path)
    expect(version(db)).toBe(MIGRATIONS.length)
    // Every row is kept as it was. An Applied job gains only its channel, and
    // one from before channels existed went by form.
    expect(rowsOf(db)).toEqual({
      ...rows,
      applied_jobs: rows.applied_jobs!.map((r) => ({ ...(r as object), channel: 'form' })),
    })
    db.close()
  })

  it('reads every Applied job from before channels as a form application, with no prose answers kept', () => {
    const path = tempDbPath()
    oldShapeDb(path)
    const db = openDb(path)
    const jobs = listApplied(db)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ canonicalUrl: 'https://jobs.example.com/1', channel: 'form' })
    expect(listKeptProseAnswers(db, jobs[0]!.id)).toEqual([])
    db.close()
  })

  it('opens a database from before Application emails were kept with its Applied jobs and prose answers, and none of them holds an email', () => {
    const path = tempDbPath()
    // The shape the Native host left before ticket #75: the migrations up to
    // channels and kept prose answers, with rows in it.
    const before = openDb(path, MIGRATIONS.slice(0, 2))
    // The form mark goes in as the tables stood then: today's markApplied
    // writes a kind, a column this shape does not have yet (ticket #107).
    const form = { id: Number(before.prepare(
      `INSERT INTO applied_jobs (url, canonical_url, company, job_title, marked_at, channel)
       VALUES ('https://jobs.example.com/1', 'jobs.example.com/1', 'Acme', 'Engineer', '2026-11-01T00:00:00.000Z', 'form')`,
    ).run().lastInsertRowid) }
    before.prepare(
      `INSERT INTO applied_prose_answers (applied_job_id, position, question, text, ai_drafted, edited, model)
       VALUES (?, 0, 'Why us?', 'Because of the engines.', 1, 0, 'claude-opus-5-5')`,
    ).run(form.id)
    const email = markApplied(before, { url: 'https://jobs.example.com/2', company: null, jobTitle: 'Analyst', channel: 'email' })
    const appliedRows = before.prepare('SELECT * FROM applied_jobs ORDER BY id').all()
    const proseRows = before.prepare('SELECT * FROM applied_prose_answers ORDER BY applied_job_id, position').all()
    before.close()

    const db = openDb(path)
    expect(version(db)).toBe(MIGRATIONS.length)
    expect(db.prepare('SELECT * FROM applied_jobs ORDER BY id').all()).toEqual(appliedRows)
    // Each kept answer gains its kind, and one kept before it was a prose answer.
    expect(db.prepare('SELECT * FROM applied_prose_answers ORDER BY applied_job_id, position').all())
      .toEqual(proseRows.map((r) => ({ ...(r as object), kind: 'prose' })))
    expect(listKeptProseAnswers(db, form.id)).toHaveLength(1)
    expect(listApplicationEmails(db, form.id)).toEqual([])
    expect(listApplicationEmails(db, email.id)).toEqual([])
    db.close()
  })

  it('refuses an Application email with a route, a language or a mark it does not know', () => {
    const db = openDb(':memory:')
    const job = markApplied(db, { url: 'https://jobs.example.com/3', company: null, jobTitle: null, channel: 'email' })
    const insert = (patch: Record<string, unknown>): unknown => db.prepare(
      `INSERT INTO application_emails (applied_job_id, apply_address, subject, body, attachment_names, sent_at, language, route, ai_drafted, edited)
       VALUES (@job, 'jobs@example.org', 's', 'b', '[]', '2026-11-18T00:00:00Z', @language, @route, @ai, 0)`,
    ).run({ job: job.id, language: 'en', route: 'mail_app', ai: 1, ...patch })
    expect(() => insert({})).not.toThrow()
    expect(() => insert({ route: 'fax' })).toThrow(/CHECK/)
    expect(() => insert({ language: 'fr' })).toThrow(/CHECK/)
    expect(() => insert({ ai: 2 })).toThrow(/CHECK/)
    expect(() => insert({ job: 9999 })).toThrow(/FOREIGN KEY/)
    db.close()
  })

  it('opens a database from before the Mail account with its rows kept, and no Mail account in it', () => {
    const path = tempDbPath()
    // The shape the Native host left before ticket #79: every migration up to
    // the Application emails, with rows in it.
    const before = openDb(path, MIGRATIONS.slice(0, 3))
    setProfile(before, { email: 'ada@example.com', firstName: 'Ada' })
    markApplied(before, {
      url: 'https://jobs.example.com/4', company: 'Acme', jobTitle: 'Analyst', channel: 'email', proseAnswers: [],
      email: {
        applyAddress: 'jobs@example.org', senderAddress: null, subject: 'Application', body: 'Hello', attachmentNames: [],
        language: 'en', gmailMessageId: null, gmailThreadId: null, route: 'mail_app', aiDrafted: true, edited: false, model: null,
      },
    })
    const tables = ['profile', 'applied_jobs', 'application_emails']
    const rowsBefore = tables.map((t) => before.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())
    before.close()

    const db = openDb(path)
    expect(version(db)).toBe(MIGRATIONS.length)
    expect(tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).toEqual(rowsBefore)
    expect(getMailAccount(db)).toBeNull()
    db.close()
  })

  it('keeps one Mail account, of a kind and a state it knows', () => {
    const db = openDb(':memory:')
    saveMailAccount(db, { kind: 'gmail', address: 'ada@example.com', clientId: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com', connectedAt: '2026-11-19T12:00:00.000Z' })
    saveMailAccount(db, { kind: 'gmail', address: 'ada@work.example.com', clientId: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com', connectedAt: '2026-11-20T12:00:00.000Z' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_account').get()).toEqual({ n: 1 })
    expect(getMailAccount(db)).toEqual({
      kind: 'gmail', address: 'ada@work.example.com', clientId: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com',
      connectedAt: '2026-11-20T12:00:00.000Z', state: 'connected', lastSenderAddress: null,
    })
    const insert = (patch: Record<string, unknown>): unknown => db.prepare(
      `INSERT OR REPLACE INTO mail_account (id, kind, address, client_id, connected_at, state)
       VALUES (@id, @kind, 'ada@example.com', 'c', '2026-11-19T12:00:00.000Z', @state)`,
    ).run({ id: 1, kind: 'gmail', state: 'connected', ...patch })
    expect(() => insert({})).not.toThrow()
    expect(() => insert({ id: 2 })).toThrow(/CHECK/)
    expect(() => insert({ kind: 'outlook' })).toThrow(/CHECK/)
    expect(() => insert({ state: 'asleep' })).toThrow(/CHECK/)
    db.close()
  })

  it('opens a database from before send attempts with its rows kept, and no send attempt in it', () => {
    const path = tempDbPath()
    // The shape the Native host left before ticket #82: every migration up to
    // the Mail account, with rows in it.
    const before = openDb(path, MIGRATIONS.slice(0, 4))
    setProfile(before, { email: 'ada@example.com' })
    saveMailAccount(before, { kind: 'gmail', address: 'ada@example.com', clientId: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com', connectedAt: '2026-11-19T12:00:00.000Z' })
    const tables = ['profile', 'mail_account']
    const rowsBefore = tables.map((t) => before.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())
    before.close()

    const db = openDb(path)
    expect(version(db)).toBe(MIGRATIONS.length)
    expect(tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).toEqual(rowsBefore)
    expect(db.prepare('SELECT COUNT(*) AS n FROM send_attempts').get()).toEqual({ n: 0 })
    db.close()
  })

  it('makes the send attempt insert a lock: unique on the request id, one started attempt per Job posting and Apply address', () => {
    const db = openDb(':memory:')
    const insert = (requestId: string, patch: { url?: string; to?: string; state?: string } = {}): unknown => db.prepare(
      `INSERT INTO send_attempts (request_id, canonical_url, apply_address, state, started_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-11-19T12:00:00.000Z', '2026-11-19T12:00:00.000Z')`,
    ).run(requestId, patch.url ?? 'careers.example.com/jobs/1', patch.to ?? 'jobs@example.org', patch.state ?? 'started')

    expect(() => insert('r1')).not.toThrow()
    // The same request id, whatever else it carries.
    expect(() => insert('r1', { url: 'careers.example.com/jobs/2', state: 'failed' })).toThrow(/UNIQUE|PRIMARY/)
    // A second started attempt for the same Job posting and Apply address.
    expect(() => insert('r2')).toThrow(/UNIQUE/)
    // Another Apply address, or another Job posting, is a Send of its own.
    expect(() => insert('r3', { to: 'hr@example.org' })).not.toThrow()
    expect(() => insert('r4', { url: 'careers.example.com/jobs/2' })).not.toThrow()
    // Once the first is no longer started, a new one may start.
    db.prepare(`UPDATE send_attempts SET state = 'failed' WHERE request_id = 'r1'`).run()
    expect(() => insert('r5')).not.toThrow()
    expect(() => insert('r6', { state: 'failed' })).not.toThrow()
    expect(() => insert('r7', { state: 'lost' })).toThrow(/CHECK/)
    db.close()
  })

  it('refuses a channel other than form or email', () => {
    const db = openDb(':memory:')
    expect(() => db.prepare(`INSERT INTO applied_jobs (url, canonical_url, marked_at, channel)
                             VALUES ('https://x.example.com/1', 'x.example.com/1', '2026-11-18T00:00:00Z', 'fax')`).run())
      .toThrow(/CHECK/)
    db.close()
  })

  it('ends a new database and an upgraded one with the same tables and the same version', () => {
    const upgradedPath = tempDbPath()
    oldShapeDb(upgradedPath)
    const upgraded = openDb(upgradedPath)
    const fresh = openDb(tempDbPath())
    expect(shapeOf(fresh)).toEqual(shapeOf(upgraded))
    expect(version(fresh)).toBe(version(upgraded))
    expect(version(fresh)).toBeGreaterThan(0)
    upgraded.close()
    fresh.close()
  })

  it('applies nothing to a database that is up to date', () => {
    const path = tempDbPath()
    let applied = 0
    const migrations = [...MIGRATIONS, addProbeColumn(() => { applied++ })]
    openDb(path, migrations).close()
    const again = openDb(path, migrations)
    expect(applied).toBe(1)
    expect(version(again)).toBe(migrations.length)
    again.close()
  })

  it('rolls a failed migration back whole and leaves the version where it was', () => {
    const path = tempDbPath()
    openDb(path).close()
    const broken: Migration = {
      version: MIGRATIONS.length + 1,
      name: 'test: half-applied, then throws',
      up: (db) => { db.exec('CREATE TABLE half (x INTEGER)'); throw new Error('boom') },
    }
    expect(() => openDb(path, [...MIGRATIONS, broken])).toThrow('boom')
    const db = new DatabaseCtor(path, { readonly: true })
    expect(version(db)).toBe(MIGRATIONS.length)
    expect(shapeOf(db).map((t) => t.name)).not.toContain('half')
    db.close()
  })

  it('refuses a database from a newer version of the tool and writes nothing to it', () => {
    const path = tempDbPath()
    const seed = openDb(path)
    setProfile(seed, { email: 'ada@example.com' })
    seed.pragma(`user_version = ${MIGRATIONS.length + 1}`)
    seed.close()

    let error: unknown
    try { openDb(path) } catch (e) { error = e }
    expect(error).toBeInstanceOf(DatabaseTooNew)
    expect((error as Error).message).toMatch(/newer version of the tool/)

    const db = new DatabaseCtor(path, { readonly: true })
    expect(version(db)).toBe(MIGRATIONS.length + 1)
    expect(getProfile(db)).toEqual({ email: 'ada@example.com' })
    db.close()
  })
})

/* ------------------------------------------------- across real processes */

/** Resolves with the child's first stdout line, rejects if it exits first. */
function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((ok, fail) => {
    let buf = ''
    let err = ''
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl >= 0) ok(buf.slice(0, nl))
    })
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8') })
    child.on('exit', (code) => fail(new Error(`child exited ${String(code)} before a line: ${err}`)))
  })
}

// Longer than better-sqlite3's own 5s default wait, so a write that succeeds
// after it proves the Native host's own busy timeout, not the library's.
const HOLD_MS = 7_000

/** An "It arrived" record for one new Job posting, under a fresh request id. */
const arrivedEmail = (): Parameters<typeof recordArrivedEmail>[1] => ({
  requestId: crypto.randomUUID(), url: 'https://jobs.example.com/arrived', company: null, jobTitle: null,
  email: {
    applyAddress: 'jobs@example.org', senderAddress: null, subject: 'Application', body: 'Hello', attachmentNames: [],
    language: 'en', gmailMessageId: null, gmailThreadId: null, route: 'tool', aiDrafted: true, edited: false, model: null,
  },
})

describe('openDb across processes', () => {
  it("makes a write wait for another process's lock and then succeed", async () => {
    const path = tempDbPath()
    const db = openDb(path)

    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module'
      const Database = createRequire(import.meta.url)(${JSON.stringify(BETTER_SQLITE)})
      const db = new Database(${JSON.stringify(path)})
      db.exec('BEGIN IMMEDIATE')
      db.prepare("INSERT INTO profile (key, value) VALUES ('firstName', 'Ada')").run()
      process.stdout.write('locked\\n')
      setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0) }, ${HOLD_MS})
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(holder)
    expect(await firstLine(holder)).toBe('locked')

    const started = Date.now()
    setProfile(db, { email: 'ada@example.com' })
    expect(Date.now() - started).toBeGreaterThan(HOLD_MS / 2)
    expect(getProfile(db)).toEqual({ email: 'ada@example.com', firstName: 'Ada' })
    db.close()
  }, 30_000)

  it('records "It arrived" after another process commits a write, instead of failing at once (#90)', async () => {
    const path = tempDbPath()
    const db = openDb(path)

    // A deferred transaction would read first, then ask for the write lock the
    // holder still has. SQLite runs no busy handler for a connection that
    // already holds a read, so it would fail with SQLITE_BUSY at once instead
    // of waiting for the commit.
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module'
      const Database = createRequire(import.meta.url)(${JSON.stringify(BETTER_SQLITE)})
      const db = new Database(${JSON.stringify(path)})
      db.exec('BEGIN IMMEDIATE')
      db.prepare("INSERT INTO profile (key, value) VALUES ('firstName', 'Ada')").run()
      process.stdout.write('locked\\n')
      setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0) }, 1_500)
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(holder)
    expect(await firstLine(holder)).toBe('locked')

    expect(recordArrivedEmail(db, arrivedEmail()).ok).toBe(true)
    expect(getProfile(db)).toEqual({ firstName: 'Ada' })
    db.close()
  }, 30_000)

  it('"It arrived" waits out the busy timeout for a write lock another connection holds, instead of failing at once (#90)', () => {
    const path = tempDbPath()
    const db = openDb(path)
    db.pragma('busy_timeout = 400')
    // One process, two connections: the lock is held for the whole synchronous
    // call, so the contention cannot slip away under load.
    const other = new DatabaseCtor(path)
    other.exec('BEGIN IMMEDIATE')
    other.prepare("INSERT INTO profile (key, value) VALUES ('firstName', 'Ada')").run()

    const started = Date.now()
    expect(() => recordArrivedEmail(db, arrivedEmail())).toThrow(/database is locked/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)

    other.exec('COMMIT')
    other.close()
    expect(recordArrivedEmail(db, arrivedEmail()).ok).toBe(true)
    db.close()
  })

  it('migrates an old database file once when two processes open it at the same moment', async () => {
    const path = tempDbPath()
    oldShapeDb(path)

    // Each child loads openDb, says ready, and opens the file only on "go", with
    // the shipped migrations plus one that adds a column, holds the lock for a
    // second, and fails if it runs a second time.
    const start = (): ChildProcess => {
      const child = spawn(process.execPath, [VITE_NODE, RACE_CHILD], {
        cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, JFF_RACE_DB: path, HOME: dirname(path) },
      })
      children.push(child)
      return child
    }
    const a = start()
    const b = start()
    expect(await Promise.all([firstLine(a), firstLine(b)])).toEqual(['ready', 'ready'])

    const outcome = (child: ChildProcess): Promise<{ code: number | null; out: string }> =>
      new Promise((ok) => {
        let out = ''
        child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8') })
        child.stderr?.on('data', (d: Buffer) => { out += d.toString('utf8') })
        child.on('exit', (code) => ok({ code, out }))
      })
    const done = Promise.all([outcome(a), outcome(b)])
    a.stdin?.write('go\n')
    b.stdin?.write('go\n')
    const results = await done

    expect(results.map((r) => r.code), results.map((r) => r.out).join('\n')).toEqual([0, 0])
    const db = new DatabaseCtor(path, { readonly: true })
    expect(version(db)).toBe(MIGRATIONS.length + 1)
    expect(getProfile(db)).toEqual({ email: 'ada@example.com', firstName: 'Ada' })
    db.close()
  }, 60_000)
})
