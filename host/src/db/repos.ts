import DatabaseCtor from 'better-sqlite3'
import type Database from 'better-sqlite3'
import {
  isProfileKey, norm,
  type AppliedChannel, type AppliedTexts, type ApplicationEmail, type EmailLanguage, type EmailRoute, type FieldClass, type FieldKey, type KeptProseAnswer, type MailKind,
} from '@jff/shared'
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

/** About me (spec #98): the stored text, empty when the user wrote none. */
export function getAboutMe(db: Database.Database): string {
  const row = db.prepare('SELECT text FROM about_me WHERE id = 1').get() as { text: string } | undefined
  return row?.text ?? ''
}

/** Stores About me as written; a blank text is no About me. The caller holds
 *  it to ABOUT_ME_MAX. */
export function setAboutMe(db: Database.Database, text: string): void {
  if (text.trim() === '') db.prepare('DELETE FROM about_me WHERE id = 1').run()
  else db.prepare('INSERT INTO about_me (id, text) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text').run(text)
}

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

/** Every Reusable Saved answer, both languages, in the order first saved,
 *  latest first: an upsert keeps a row's id, so a correction keeps its place.
 *  Generation reads them as facts (spec #98). */
export function listReusableAnswersNewestFirst(db: Database.Database): QaRow[] {
  const rows = db.prepare(
    `SELECT * FROM qa_memory WHERE reusability = 'reusable' ORDER BY id DESC`,
  ).all() as RawQa[]
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
 *  mark's too (spec #66): a later form mark, or one that carries prose
 *  answers, replaces them in the same transaction as the upsert. An email mark
 *  with none leaves them: it has nothing to put in place of texts that were
 *  sent to an employer. A prose answer with no text is not kept.
 *
 *  An `email` is the Application email the mark records, stored beside the
 *  Applied job in the same transaction. A later mark adds one and never
 *  deletes one. */
export function markApplied(
  db: Database.Database,
  row: {
    url: string; company: string | null; jobTitle: string | null
    channel?: AppliedChannel; proseAnswers?: readonly KeptProseAnswer[]
    email?: NewApplicationEmail
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
    if ((row.channel ?? 'form') === 'form' || kept.length > 0) {
      db.prepare(`DELETE FROM applied_prose_answers WHERE applied_job_id = ?`).run(got.id)
      const insert = db.prepare(
        `INSERT INTO applied_prose_answers (applied_job_id, position, question, text, ai_drafted, edited, model, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      kept.forEach((a, i) => {
        insert.run(got.id, i, a.question, a.text, a.aiDrafted ? 1 : 0, a.edited ? 1 : 0, a.model, a.kind)
      })
    }
    if (row.email !== undefined) insertApplicationEmail(db, got.id, row.email)
    return got
  })
  return tx()
}

/** An Application email to keep: the stored fields less the time, which the
 *  Native host sets when it stores it. */
export type NewApplicationEmail = Omit<ApplicationEmail, 'sentAt'>

function insertApplicationEmail(db: Database.Database, appliedJobId: number, e: NewApplicationEmail): void {
  db.prepare(
    `INSERT INTO application_emails (applied_job_id, apply_address, sender_address, subject, body, attachment_names,
       sent_at, language, gmail_message_id, gmail_thread_id, route, ai_drafted, edited, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    appliedJobId, e.applyAddress, e.senderAddress, e.subject, e.body, JSON.stringify(e.attachmentNames),
    new Date().toISOString(), e.language, e.gmailMessageId, e.gmailThreadId, e.route,
    e.aiDrafted ? 1 : 0, e.edited ? 1 : 0, e.model,
  )
}

/** The Application emails kept beside one Applied job, newest first. */
export function listApplicationEmails(db: Database.Database, appliedJobId: number): ApplicationEmail[] {
  const rows = db.prepare(
    `SELECT apply_address, sender_address, subject, body, attachment_names, sent_at, language,
            gmail_message_id, gmail_thread_id, route, ai_drafted, edited, model
     FROM application_emails WHERE applied_job_id = ? ORDER BY sent_at DESC, id DESC`,
  ).all(appliedJobId) as {
    apply_address: string; sender_address: string | null; subject: string; body: string; attachment_names: string
    sent_at: string; language: EmailLanguage; gmail_message_id: string | null; gmail_thread_id: string | null
    route: EmailRoute; ai_drafted: number; edited: number; model: string | null
  }[]
  return rows.map((r) => ({
    applyAddress: r.apply_address, senderAddress: r.sender_address, subject: r.subject, body: r.body,
    attachmentNames: JSON.parse(r.attachment_names) as string[], sentAt: r.sent_at, language: r.language,
    gmailMessageId: r.gmail_message_id, gmailThreadId: r.gmail_thread_id, route: r.route,
    aiDrafted: r.ai_drafted === 1, edited: r.edited === 1, model: r.model,
  }))
}

/** One Applied job's stored texts, or null when no Applied job has the id. */
export function getAppliedTexts(db: Database.Database, appliedJobId: number): AppliedTexts | null {
  const exists = db.prepare(`SELECT 1 FROM applied_jobs WHERE id = ?`).get(appliedJobId)
  if (exists === undefined) return null
  return {
    id: appliedJobId,
    proseAnswers: listKeptProseAnswers(db, appliedJobId),
    emails: listApplicationEmails(db, appliedJobId),
  }
}

export function checkApplied(db: Database.Database, url: string): AppliedJob | null {
  const row = db.prepare(`SELECT ${APPLIED_COLUMNS} FROM applied_jobs WHERE canonical_url = ?`)
    .get(canonicalUrl(url)) as RawApplied | undefined
  return row === undefined ? null : toApplied(row)
}

/** The Applied job whose Application email went to one of these addresses,
 *  compared without regard to case, or null (spec #66). An email handed to
 *  the mail app counts: its mark keeps the Apply address. The newest such
 *  email wins. */
export function checkAppliedByAddress(db: Database.Database, addresses: readonly string[]): AppliedJob | null {
  const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a !== ''))]
  if (wanted.length === 0) return null
  const row = db.prepare(
    `SELECT ${APPLIED_COLUMNS.split(', ').map((c) => `j.${c}`).join(', ')}
     FROM application_emails e JOIN applied_jobs j ON j.id = e.applied_job_id
     WHERE lower(e.apply_address) IN (${wanted.map(() => '?').join(', ')})
     ORDER BY e.sent_at DESC, e.id DESC LIMIT 1`,
  ).get(...wanted) as RawApplied | undefined
  return row === undefined ? null : toApplied(row)
}

export function listApplied(db: Database.Database): AppliedJob[] {
  return (db.prepare(`SELECT ${APPLIED_COLUMNS} FROM applied_jobs ORDER BY marked_at DESC, id DESC`).all() as RawApplied[]).map(toApplied)
}

/** The answers kept beside one Applied job, prose and personal fact, each
 *  with its kind, in the order the mark sent them. */
export function listKeptProseAnswers(db: Database.Database, appliedJobId: number): KeptProseAnswer[] {
  const rows = db.prepare(
    `SELECT question, text, ai_drafted, edited, model, kind FROM applied_prose_answers
     WHERE applied_job_id = ? ORDER BY position`,
  ).all(appliedJobId) as { question: string; text: string; ai_drafted: number; edited: number; model: string | null; kind: FieldClass }[]
  return rows.map((r) => ({
    question: r.question, text: r.text, aiDrafted: r.ai_drafted === 1, edited: r.edited === 1, model: r.model, kind: r.kind,
  }))
}

/* ------------------------------------------------------------ Mail account */

export type MailAccountState = 'connected' | 'needs_reconnect'

/** The one Mail account, as the database holds it. Its secrets are in the
 *  Keychain (spec #66): nothing here is one. */
export interface MailAccountRow {
  kind: MailKind
  address: string
  clientId: string
  connectedAt: string
  state: MailAccountState
  lastSenderAddress: string | null
}

export function getMailAccount(db: Database.Database): MailAccountRow | null {
  const r = db.prepare(
    `SELECT kind, address, client_id, connected_at, state, last_sender_address FROM mail_account WHERE id = 1`,
  ).get() as {
    kind: MailKind; address: string; client_id: string; connected_at: string; state: MailAccountState; last_sender_address: string | null
  } | undefined
  return r === undefined ? null : {
    kind: r.kind, address: r.address, clientId: r.client_id, connectedAt: r.connected_at,
    state: r.state, lastSenderAddress: r.last_sender_address,
  }
}

/** Forgets the one Mail account's row. Its secrets live in the secret store. */
export function deleteMailAccount(db: Database.Database): void {
  db.prepare('DELETE FROM mail_account WHERE id = 1').run()
}

/** Sets the one Mail account's state: "needs reconnect" once Google refused
 *  its sign-in as invalid. A finished Connect sets it back to connected. */
export function setMailAccountState(db: Database.Database, state: MailAccountState): void {
  db.prepare('UPDATE mail_account SET state = ? WHERE id = 1').run(state)
}

/** Writes the one Mail account as just connected. A second connect replaces
 *  the first; the last used Sender address survives only for the same address. */
export function saveMailAccount(
  db: Database.Database,
  row: { kind: MailKind; address: string; clientId: string; connectedAt: string },
): void {
  db.prepare(
    `INSERT INTO mail_account (id, kind, address, client_id, connected_at, state, last_sender_address)
     VALUES (1, @kind, @address, @clientId, @connectedAt, 'connected', NULL)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind, client_id = excluded.client_id, connected_at = excluded.connected_at, state = 'connected',
       last_sender_address = CASE WHEN address = excluded.address THEN last_sender_address ELSE NULL END,
       address = excluded.address`,
  ).run(row)
}

/** Records the Sender address the last Application email left from: the
 *  default of the next email Review while the list still holds it. */
export function setLastSenderAddress(db: Database.Database, address: string): void {
  db.prepare('UPDATE mail_account SET last_sender_address = ? WHERE id = 1').run(address)
}

/* ----------------------------------------------------------- send attempts */

export type SendAttemptState = 'started' | 'sent' | 'failed' | 'abandoned'

export interface SendAttempt {
  requestId: string
  canonicalUrl: string
  applyAddress: string
  state: SendAttemptState
}

/** The Apply address as a send attempt keeps it, so the lock compares it
 *  without regard to case. */
const attemptAddress = (a: string): string => a.trim().toLowerCase()

/**
 * Records a send attempt as `started` before Gmail is called (spec #66). The
 * insert is the lock: it is refused for a request id already recorded
 * (`same_request`), and for a Job posting and Apply address that already
 * have a started attempt (`in_flight`). The database enforces both, so they
 * hold across Native host processes.
 */
export function startSendAttempt(
  db: Database.Database,
  a: { requestId: string; url: string; applyAddress: string },
): { ok: true } | { ok: false; why: 'same_request' | 'in_flight' } {
  const now = new Date().toISOString()
  try {
    db.prepare(
      `INSERT INTO send_attempts (request_id, canonical_url, apply_address, state, started_at, updated_at)
       VALUES (?, ?, ?, 'started', ?, ?)`,
    ).run(a.requestId, canonicalUrl(a.url), attemptAddress(a.applyAddress), now, now)
    return { ok: true }
  } catch (e) {
    const code = (e as { code?: unknown }).code
    if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return { ok: false, why: 'same_request' }
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') return { ok: false, why: 'in_flight' }
    throw e
  }
}

/** Moves a started attempt to `state`. One no longer started is left as it
 *  is: a user's "Send again" or "It arrived" settled it first. */
export function setSendAttemptState(db: Database.Database, requestId: string, state: SendAttemptState): void {
  db.prepare(`UPDATE send_attempts SET state = ?, updated_at = ? WHERE request_id = ? AND state = 'started'`)
    .run(state, new Date().toISOString(), requestId)
}

/** "Send again" (ticket #83): the started attempt the user gave up on
 *  becomes `abandoned`. One no longer started is left as it is. */
export function abandonSendAttempt(db: Database.Database, requestId: string): void {
  setSendAttemptState(db, requestId, 'abandoned')
}

type RawAttempt = { request_id: string; canonical_url: string; apply_address: string; state: SendAttemptState }
const toAttempt = (r: RawAttempt): SendAttempt =>
  ({ requestId: r.request_id, canonicalUrl: r.canonical_url, applyAddress: r.apply_address, state: r.state })

export function getSendAttempt(db: Database.Database, requestId: string): SendAttempt | null {
  const r = db.prepare('SELECT request_id, canonical_url, apply_address, state FROM send_attempts WHERE request_id = ?').get(requestId) as
    RawAttempt | undefined
  return r === undefined ? null : toAttempt(r)
}

/** The latest attempt in `state` for a Job posting and Apply address, or null. */
export function findSendAttempt(db: Database.Database, url: string, applyAddress: string, state: SendAttemptState): SendAttempt | null {
  const r = db.prepare(
    `SELECT request_id, canonical_url, apply_address, state FROM send_attempts
     WHERE canonical_url = ? AND apply_address = ? AND state = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
  ).get(canonicalUrl(url), attemptAddress(applyAddress), state) as RawAttempt | undefined
  return r === undefined ? null : toAttempt(r)
}

/** What a sent attempt answered, as `recordSentEmail` kept it. */
export interface SentAnswer {
  appliedJobId: number
  markedAt: string
  gmailMessageId: string
  gmailThreadId: string
}

/** The answer a sent attempt gave, or null when it is not sent or holds
 *  none (one the user settled with "It arrived"). */
export function getSentAnswer(db: Database.Database, requestId: string): SentAnswer | null {
  const r = db.prepare(`SELECT answer FROM send_attempts WHERE request_id = ? AND state = 'sent'`).get(requestId) as
    { answer: string | null } | undefined
  return r?.answer == null ? null : JSON.parse(r.answer) as SentAnswer
}

/**
 * A Send that went out, recorded in one transaction (spec #66): the Job
 * posting marked applied by email, its Application email kept with Gmail's
 * ids, the attempt `sent` with its answer kept, and the Sender address
 * recorded as the last used. A failure anywhere leaves none of them.
 */
export function recordSentEmail(
  db: Database.Database,
  r: {
    requestId: string; url: string; company: string | null; jobTitle: string | null
    email: NewApplicationEmail & { senderAddress: string; gmailMessageId: string; gmailThreadId: string }
  },
): SentAnswer {
  const tx = db.transaction((): SentAnswer => {
    const job = markApplied(db, { url: r.url, company: r.company, jobTitle: r.jobTitle, channel: 'email', email: r.email })
    const answer: SentAnswer = {
      appliedJobId: job.id, markedAt: job.markedAt, gmailMessageId: r.email.gmailMessageId, gmailThreadId: r.email.gmailThreadId,
    }
    const moved = db.prepare(
      `UPDATE send_attempts SET state = 'sent', answer = ?, updated_at = ? WHERE request_id = ? AND state = 'started'`,
    ).run(JSON.stringify(answer), new Date().toISOString(), r.requestId)
    if (moved.changes !== 1) throw new Error(`send attempt ${r.requestId} is no longer started`)
    setLastSenderAddress(db, r.email.senderAddress)
    return answer
  })
  return tx()
}

/**
 * "It arrived" (ticket #83), in one transaction: the Job posting marked
 * applied by email, the Application email kept with no Gmail ids, and the
 * attempt `sent`. An attempt already sent records nothing again and answers
 * its Applied job; one failed or abandoned is refused. An attempt the Native
 * host never recorded (the request died before it arrived) is recorded as
 * sent here.
 */
export function recordArrivedEmail(
  db: Database.Database,
  r: { requestId: string; url: string; company: string | null; jobTitle: string | null; email: NewApplicationEmail },
): { ok: true; job: AppliedJob } | { ok: false; state: SendAttemptState } {
  const tx = db.transaction((): { ok: true; job: AppliedJob } | { ok: false; state: SendAttemptState } => {
    const attempt = getSendAttempt(db, r.requestId)
    if (attempt?.state === 'sent') {
      const job = checkApplied(db, r.url)
      if (job !== null) return { ok: true, job }
    }
    if (attempt !== null && attempt.state !== 'started' && attempt.state !== 'sent') return { ok: false, state: attempt.state }
    const job = markApplied(db, { url: r.url, company: r.company, jobTitle: r.jobTitle, channel: 'email', email: r.email })
    const now = new Date().toISOString()
    if (attempt === null) {
      db.prepare(
        `INSERT INTO send_attempts (request_id, canonical_url, apply_address, state, started_at, updated_at)
         VALUES (?, ?, ?, 'sent', ?, ?)`,
      ).run(r.requestId, canonicalUrl(r.url), attemptAddress(r.email.applyAddress), now, now)
    } else {
      db.prepare(`UPDATE send_attempts SET state = 'sent', updated_at = ? WHERE request_id = ?`).run(now, r.requestId)
    }
    if (r.email.senderAddress !== null) setLastSenderAddress(db, r.email.senderAddress)
    return { ok: true, job }
  })
  // Immediate, as a Send's begin(). A deferred transaction reads first, and its
  // upgrade to a write fails at once with SQLITE_BUSY when another panel holds
  // the write lock or has committed since that read: the busy timeout covers
  // neither.
  return tx.immediate()
}
