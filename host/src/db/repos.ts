import DatabaseCtor from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { isProfileKey, type FieldKey } from '@jff/shared'
import { canonicalUrl } from '../canonicalUrl.js'
import { migrate } from './schema.js'

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

export function openDb(path: string): Database.Database {
  const db = new DatabaseCtor(path)
  // WAL: the panel's single port is the only client, but WAL also survives a
  // host crash mid-write far better than the default rollback journal.
  if (path !== ':memory:') db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  // The idempotency ledger only needs to survive a reconnect, not a career.
  pruneRequestLog(db, new Date(Date.now() - REQUEST_LOG_TTL_MS).toISOString())
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
}

interface RawApplied {
  id: number; url: string; canonical_url: string
  company: string | null; job_title: string | null; marked_at: string
}

const toApplied = (r: RawApplied): AppliedJob => ({
  id: r.id, url: r.url, canonicalUrl: r.canonical_url,
  company: r.company, jobTitle: r.job_title, markedAt: r.marked_at,
})

/** Upsert by canonical_url. `marked_at` is NOT in the update set: re-marking
 *  after a "Scan anyway" re-apply keeps the ORIGINAL date (spec A1).
 *
 *  The identity columns follow the same rule via COALESCE. The panel sends
 *  `company: null` for a blank field and `jobTitle: null` for an empty tab title,
 *  and both are routine on a re-mark (the company guess misses on a step-2 url,
 *  the tab has not settled its title yet). A plain `excluded.company` there
 *  DELETES a company the first mark got right — a null is "I have nothing to
 *  say", never "erase what you know". */
export function markApplied(
  db: Database.Database,
  row: { url: string; company: string | null; jobTitle: string | null },
): AppliedJob {
  const canonical = canonicalUrl(row.url)
  db.prepare(
    `INSERT INTO applied_jobs (url, canonical_url, company, job_title, marked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(canonical_url) DO UPDATE SET
       url = excluded.url,
       company = COALESCE(excluded.company, company),
       job_title = COALESCE(excluded.job_title, job_title)`,
  ).run(row.url, canonical, row.company, row.jobTitle, new Date().toISOString())
  const got = db.prepare(`SELECT * FROM applied_jobs WHERE canonical_url = ?`).get(canonical) as RawApplied
  return toApplied(got)
}

export function checkApplied(db: Database.Database, url: string): AppliedJob | null {
  const row = db.prepare(`SELECT * FROM applied_jobs WHERE canonical_url = ?`)
    .get(canonicalUrl(url)) as RawApplied | undefined
  return row === undefined ? null : toApplied(row)
}

export function listApplied(db: Database.Database): AppliedJob[] {
  return (db.prepare(`SELECT * FROM applied_jobs ORDER BY marked_at DESC, id DESC`).all() as RawApplied[]).map(toApplied)
}
