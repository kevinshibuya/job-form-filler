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
import { getProfile, openDb, setProfile } from './repos.js'
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
    expect(rowsOf(db)).toEqual(rows)
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
