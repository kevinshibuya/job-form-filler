import DatabaseCtor from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { isProfileKey, norm, type AppliedChannel, type FieldKey, type KeptProseAnswer } from '@jff/shared'
import { canonicalUrl } from '../canonicalUrl.js'
import { MIGRATIONS, migrate, type Migration } from './migrations.js'

const REQUEST_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type Lang = 'en' | 'pt'
export type Reusability = 'reusable' | 'company_specific'

export interface QaRow {
  id: number
  questionNormalized: string
  questionRaw: string
  answer: string
  language: Lang
  reusability: Reusability
  timesUsed: number
  lastUsedAt: string | null
  sourceUrl: string | null
}

export interface NewQaRow {
  questionNormalized: string
  questionRaw: string
  answer: string
  language: Lang
  reusability: Reusability
  sourceUrl?: string | null
}

interface RawQa {
  id: number; question_normalized: string; question_raw: string; answer: string
  language: Lang; reusability: Reusability; times_used: number
  last_used_at: string | null; source_url: string | null
}

function toQa(r: RawQa): QaRow {
  return {
    id: r.id, questionNormalized: r.question_normalized, questionRaw: r.question_raw,
    answer: r.answer, language: r.language, reusability: r.reusability,
    timesUsed: r.times_used, lastUsedAt: r.last_used_at, sourceUrl: r.source_url,
  }
}

/**
 * How long a statement waits for another Native host's lock before it fails.
 * Each panel document runs its own Native host, so several can share the file;
 * writes are short, but a migration on a large table may hold the lock a while,
 * and a request that waits beats one that fails. Set past better-sqlite3's own
 * 5s default on purpose, so this is the wait in force.
 */
const BUSY_TIMEOUT_MS = 15_000

/**
 * Opens the database and brings it to the last of `migrations`. Throws
 * DatabaseTooNew (./migrations.ts), with the file untouched by any request,
 * when a newer version of the tool wrote it.
 */
export function openDb(path: string, migrations: readonly Migration[] = MIGRATIONS): Database.Database {
  const db = new DatabaseCtor(path)
  // The busy timeout and WAL together let several Native host processes share
  // the file: readers never block, and a writer waits for another's lock. WAL
  // also survives a crash mid-write far better than the rollback journal.
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
  if (path !== ':memory:') db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  try {
    migrate(db, migrations)
  } catch (e) {
    db.close()
    throw e
  }
  // The idempotency ledger only needs to survive a reconnect, not a career.
  pruneRequestLog(db, new Date(Date.now() - REQUEST_LOG_TTL_MS).toISOString())
  return db
}

/** The refused file (a newer version of the tool wrote it), opened so nothing
 *  can write to it: no migration, no pruning, SQLite itself refuses a write. */
export function openDbReadOnly(path: string): Database.Database {
  const db = new DatabaseCtor(path, { readonly: true, fileMustExist: true })
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
  return db
}

/* ------------------------------------------------------- profile / answers */

function readKv(db: Database.Database, table: 'profile' | 'answer_bank'): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM ${table}`).all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

function writeKv(db: Database.Database, table: 'profile' | 'answer_bank', values: Record<string, string>): void {
  const stmt = db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)
                           ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
  const del = db.prepare(`DELETE FROM ${table} WHERE key = ?`)
  const tx = db.transaction((vals: Record<string, string>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === '') del.run(k)
      else stmt.run(k, v)
    }
  })
  tx(values)
}

export const getProfile = (db: Database.Database): Record<string, string> => readKv(db, 'profile')
export const setProfile = (db: Database.Database, values: Record<string, string>): void => writeKv(db, 'profile', values)
export const getAnswerBank = (db: Database.Database): Record<string, string> => readKv(db, 'answer_bank')
export const setAnswerBank = (db: Database.Database, values: Record<string, string>): void => writeKv(db, 'answer_bank', values)

/** Routes a FieldKey to the table that owns it. Returns null when unset. */
export function getStoredValue(db: Database.Database, key: FieldKey): string | null {
  const table = isProfileKey(key) ? 'profile' : 'answer_bank'
  const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}

/* --------------------------------------------------------------- qa_memory */

export function findExactAnswer(db: Database.Database, questionNormalized: string, language: Lang): QaRow | null {
  const row = db.prepare(
    `SELECT * FROM qa_memory WHERE question_normalized = ? AND language = ?`,
  ).get(questionNormalized, language) as RawQa | undefined
  return row ? toQa(row) : null
}

/** Mapping-prompt candidates. company_specific rows are EXCLUDED by design. */
export function listReusableAnswers(db: Database.Database, language: Lang): QaRow[] {
  const rows = db.prepare(
    `SELECT * FROM qa_memory WHERE language = ? AND reusability = 'reusable' ORDER BY times_used DESC, id ASC`,
  ).all(language) as RawQa[]
  return rows.map(toQa)
}

/** company_specific prior drafts for the SAME question — [Generate] reference only. */
export function listReferenceAnswers(db: Database.Database, questionNormalized: string, language: Lang): QaRow[] {
  const rows = db.prepare(
    `SELECT * FROM qa_memory WHERE question_normalized = ? AND language = ? AND reusability = 'company_specific' ORDER BY id DESC LIMIT 3`,
  ).all(questionNormalized, language) as RawQa[]
  return rows.map(toQa)
}

export function getAnswerById(db: Database.Database, id: number): QaRow | null {
  const row = db.prepare(`SELECT * FROM qa_memory WHERE id = ?`).get(id) as RawQa | undefined
  return row ? toQa(row) : null
}

export function upsertAnswer(db: Database.Database, row: NewQaRow): number {
  db.prepare(
    `INSERT INTO qa_memory (question_normalized, question_raw, answer, language, reusability, source_url)
     VALUES (@questionNormalized, @questionRaw, @answer, @language, @reusability, @sourceUrl)
     ON CONFLICT(question_normalized, language) DO UPDATE SET
       question_raw = excluded.question_raw,
       answer       = excluded.answer,
       reusability  = excluded.reusability,
       source_url   = excluded.source_url`,
  ).run({ ...row, sourceUrl: row.sourceUrl ?? null })
  const got = db.prepare(
    `SELECT id FROM qa_memory WHERE question_normalized = ? AND language = ?`,
  ).get(row.questionNormalized, row.language) as { id: number }
  return got.id
}

export function touchAnswer(db: Database.Database, id: number): void {
  db.prepare(`UPDATE qa_memory SET times_used = times_used + 1, last_used_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id)
}

export function listAllAnswers(db: Database.Database): QaRow[] {
  return (db.prepare(`SELECT * FROM qa_memory ORDER BY id ASC`).all() as RawQa[]).map(toQa)
}

/* ----------------------------------------------- learned mappings/selectors */

export function getLearnedMapping(db: Database.Database, labelNormalized: string): FieldKey | null {
  const row = db.prepare(`SELECT field_key FROM learned_mappings WHERE label_normalized = ?`)
    .get(labelNormalized) as { field_key: string } | undefined
  return (row?.field_key as FieldKey | undefined) ?? null
}

export function saveLearnedMapping(db: Database.Database, labelNormalized: string, key: FieldKey): void {
  db.prepare(
    `INSERT INTO learned_mappings (label_normalized, field_key, confirmed_at) VALUES (?, ?, ?)
     ON CONFLICT(label_normalized) DO UPDATE SET field_key = excluded.field_key, confirmed_at = excluded.confirmed_at`,
  ).run(labelNormalized, key, new Date().toISOString())
}

/**
 * Stores a Learned wording for a key and the canonical Value it stood for.
 * The same wording, compared through `norm`, is kept once.
 */
export function saveLearnedWording(db: Database.Database, key: FieldKey, value: string, wording: string): void {
  db.prepare(
    `INSERT INTO learned_wordings (field_key, value, wording, wording_normalized, learned_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(field_key, value, wording_normalized) DO NOTHING`,
  ).run(key, value, wording.trim(), norm(wording), new Date().toISOString())
}

/** The wordings learned for a key and a canonical Value, oldest first. */
export function getLearnedWordings(db: Database.Database, key: FieldKey, value: string): string[] {
  const rows = db.prepare(`SELECT wording FROM learned_wordings WHERE field_key = ? AND value = ? ORDER BY rowid ASC`)
    .all(key, value) as { wording: string }[]
  return rows.map((r) => r.wording)
}

export function getSelector(db: Database.Database, hostname: string, purpose: string): string | null {
  const row = db.prepare(`SELECT selector FROM learned_selectors WHERE hostname = ? AND purpose = ?`)
    .get(hostname, purpose) as { selector: string } | undefined
  return row?.selector ?? null
}

export function saveSelector(db: Database.Database, hostname: string, purpose: string, selector: string): void {
  db.prepare(
    `INSERT INTO learned_selectors (hostname, purpose, selector) VALUES (?, ?, ?)
     ON CONFLICT(hostname, purpose) DO UPDATE SET selector = excluded.selector`,
  ).run(hostname, purpose, selector)
}

/** Forget the spot saved for a site. True when there was one. */
export function clearSelector(db: Database.Database, hostname: string, purpose: string): boolean {
  return db.prepare(`DELETE FROM learned_selectors WHERE hostname = ? AND purpose = ?`).run(hostname, purpose).changes > 0
}

/* ------------------------------------------------ applications / idempotency */

export function insertApplication(
  db: Database.Database,
  row: { url: string; company: string | null; filledCount: number; generatedCount: number },
): number {
  const info = db.prepare(
    `INSERT INTO applications (url, company, applied_at, filled_count, generated_count) VALUES (?, ?, ?, ?, ?)`,
  ).run(row.url, row.company, new Date().toISOString(), row.filledCount, row.generatedCount)
  return Number(info.lastInsertRowid)
}

export function getCachedResponse(db: Database.Database, requestId: string): string | null {
  const row = db.prepare(`SELECT response_json FROM request_log WHERE request_id = ?`)
    .get(requestId) as { response_json: string } | undefined
  return row?.response_json ?? null
}

/** First write wins: a replay must return the ORIGINAL response, never a new one. */
export function putCachedResponse(db: Database.Database, requestId: string, json: string): void {
  db.prepare(`INSERT OR IGNORE INTO request_log (request_id, response_json, created_at) VALUES (?, ?, ?)`)
    .run(requestId, json, new Date().toISOString())
}

/** created_at is always an ISO string, so a plain lexical compare is correct. */
export function pruneRequestLog(db: Database.Database, cutoffIso: string): void {
  db.prepare(`DELETE FROM request_log WHERE created_at < ?`).run(cutoffIso)
}

/* ------------------------------------------------------------- applied (A1) */

export interface AppliedJob {
  id: number
  url: string
  canonicalUrl: string
  company: string | null
  jobTitle: string | null
  markedAt: string
  channel: AppliedChannel
}

interface RawApplied {
  id: number; url: string; canonical_url: string
  company: string | null; job_title: string | null; marked_at: string
  channel: AppliedChannel
}

// Named columns, never `*`: a row read for a list carries nothing heavy.
const APPLIED_COLUMNS = 'id, url, canonical_url, company, job_title, marked_at, channel'

const toApplied = (r: RawApplied): AppliedJob => ({
  id: r.id, url: r.url, canonicalUrl: r.canonical_url,
  company: r.company, jobTitle: r.job_title, markedAt: r.marked_at, channel: r.channel,
})

/** Upsert by canonical_url. `marked_at` is NOT in the update set: re-marking
 *  after a "Scan anyway" re-apply keeps the ORIGINAL date (spec A1).
 *
 *  The identity columns follow the same rule via COALESCE. The panel sends
 *  `company: null` for a blank field and `jobTitle: null` for an empty tab title,
 *  and both are routine on a re-mark (the company guess misses on a step-2 url,
 *  the tab has not settled its title yet). A plain `excluded.company` there
 *  DELETES a company the first mark got right — a null is "I have nothing to
 *  say", never "erase what you know".
 *
 *  The channel is the latest mark's, and the kept prose answers are the latest
 *  mark's too (spec #66): a later mark replaces them, in the same transaction
 *  as the upsert. A prose answer with no text is not kept. */
export function markApplied(
  db: Database.Database,
  row: {
    url: string; company: string | null; jobTitle: string | null
    channel?: AppliedChannel; proseAnswers?: readonly KeptProseAnswer[]
  },
): AppliedJob {
  const canonical = canonicalUrl(row.url)
  const kept = (row.proseAnswers ?? []).filter((a) => a.text.trim() !== '')
  const tx = db.transaction((): AppliedJob => {
    db.prepare(
      `INSERT INTO applied_jobs (url, canonical_url, company, job_title, marked_at, channel) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_url) DO UPDATE SET
         url = excluded.url,
         company = COALESCE(excluded.company, company),
         job_title = COALESCE(excluded.job_title, job_title),
         channel = excluded.channel`,
    ).run(row.url, canonical, row.company, row.jobTitle, new Date().toISOString(), row.channel ?? 'form')
    const got = toApplied(db.prepare(`SELECT ${APPLIED_COLUMNS} FROM applied_jobs WHERE canonical_url = ?`).get(canonical) as RawApplied)
    db.prepare(`DELETE FROM applied_prose_answers WHERE applied_job_id = ?`).run(got.id)
    const insert = db.prepare(
      `INSERT INTO applied_prose_answers (applied_job_id, position, question, text, ai_drafted, edited, model)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    kept.forEach((a, i) => {
      insert.run(got.id, i, a.question, a.text, a.aiDrafted ? 1 : 0, a.edited ? 1 : 0, a.model)
    })
    return got
  })
  return tx()
}

export function checkApplied(db: Database.Database, url: string): AppliedJob | null {
  const row = db.prepare(`SELECT ${APPLIED_COLUMNS} FROM applied_jobs WHERE canonical_url = ?`)
    .get(canonicalUrl(url)) as RawApplied | undefined
  return row === undefined ? null : toApplied(row)
}

export function listApplied(db: Database.Database): AppliedJob[] {
  return (db.prepare(`SELECT ${APPLIED_COLUMNS} FROM applied_jobs ORDER BY marked_at DESC, id DESC`).all() as RawApplied[]).map(toApplied)
}

/** The prose answers kept beside one Applied job, in the order the mark sent them. */
export function listKeptProseAnswers(db: Database.Database, appliedJobId: number): KeptProseAnswer[] {
  const rows = db.prepare(
    `SELECT question, text, ai_drafted, edited, model FROM applied_prose_answers
     WHERE applied_job_id = ? ORDER BY position`,
  ).all(appliedJobId) as { question: string; text: string; ai_drafted: number; edited: number; model: string | null }[]
  return rows.map((r) => ({
    question: r.question, text: r.text, aiDrafted: r.ai_drafted === 1, edited: r.edited === 1, model: r.model,
  }))
}
