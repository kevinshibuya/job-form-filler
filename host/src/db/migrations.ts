import type Database from 'better-sqlite3'
import { log } from '../log.js'
import { SCHEMA_SQL } from './schema.js'

/**
 * One step in the database's shape. `version` is the schema version the file
 * carries once `up` has run; the list is ordered and numbered 1, 2, 3, … with
 * no gaps. A shipped migration is never edited: a change is the next one.
 */
export interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
}

/**
 * The shipped migrations. The first is the schema as it stood before
 * versioning, written with IF NOT EXISTS, so a file from before this list
 * adopts version 1 with its rows untouched and a new file is built by the
 * same path. Later tickets append.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'the schema as it stood before versioning', up: (db) => db.exec(SCHEMA_SQL) },
  {
    version: 2,
    name: 'an Applied job has a channel and keeps its prose answers',
    // A row from before channels existed went by form: the default fills it.
    // A kept prose answer belongs to one Applied job and goes with it.
    up: (db) => db.exec(`
      ALTER TABLE applied_jobs ADD COLUMN channel TEXT NOT NULL DEFAULT 'form' CHECK (channel IN ('form', 'email'));

      CREATE TABLE applied_prose_answers (
        applied_job_id INTEGER NOT NULL REFERENCES applied_jobs(id) ON DELETE CASCADE,
        position       INTEGER NOT NULL,
        question       TEXT NOT NULL,
        text           TEXT NOT NULL,
        ai_drafted     INTEGER NOT NULL CHECK (ai_drafted IN (0, 1)),
        edited         INTEGER NOT NULL CHECK (edited IN (0, 1)),
        model          TEXT,
        PRIMARY KEY (applied_job_id, position)
      );
    `),
  },
  {
    version: 3,
    name: 'an Applied job keeps its Application emails',
    // An Applied job may hold several, and a later mark never deletes one.
    // The mail app's email has no Sender address, no attachments and no
    // Gmail ids; `attachment_names` is a JSON array of file names.
    up: (db) => db.exec(`
      CREATE TABLE application_emails (
        id               INTEGER PRIMARY KEY,
        applied_job_id   INTEGER NOT NULL REFERENCES applied_jobs(id) ON DELETE CASCADE,
        apply_address    TEXT NOT NULL,
        sender_address   TEXT,
        subject          TEXT NOT NULL,
        body             TEXT NOT NULL,
        attachment_names TEXT NOT NULL DEFAULT '[]',
        sent_at          TEXT NOT NULL,
        language         TEXT NOT NULL CHECK (language IN ('en', 'pt')),
        gmail_message_id TEXT,
        gmail_thread_id  TEXT,
        route            TEXT NOT NULL CHECK (route IN ('tool', 'mail_app')),
        ai_drafted       INTEGER NOT NULL CHECK (ai_drafted IN (0, 1)),
        edited           INTEGER NOT NULL CHECK (edited IN (0, 1)),
        model            TEXT
      );
      CREATE INDEX application_emails_by_job ON application_emails (applied_job_id);
    `),
  },
  {
    version: 4,
    name: 'the Mail account',
    // One Mail account: its id is always 1. Its refresh token and client
    // secret are in the Keychain, never here (spec #66).
    up: (db) => db.exec(`
      CREATE TABLE mail_account (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        kind                TEXT NOT NULL CHECK (kind IN ('gmail')),
        address             TEXT NOT NULL,
        client_id           TEXT NOT NULL,
        connected_at        TEXT NOT NULL,
        state               TEXT NOT NULL CHECK (state IN ('connected', 'needs_reconnect')),
        last_sender_address TEXT
      );
    `),
  },
  {
    version: 5,
    name: 'send attempts',
    // The Native host records a send attempt before it calls Gmail, and the
    // insert is the lock (spec #66): unique on the request id, and one
    // `started` attempt per Job posting and Apply address. The database
    // enforces both, so they hold across Native host processes. The Apply
    // address is kept trimmed and in lower case, so the index compares it
    // without regard to case.
    up: (db) => db.exec(`
      CREATE TABLE send_attempts (
        request_id    TEXT PRIMARY KEY,
        canonical_url TEXT NOT NULL,
        apply_address TEXT NOT NULL,
        state         TEXT NOT NULL CHECK (state IN ('started', 'sent', 'failed', 'abandoned')),
        started_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX send_attempts_one_started ON send_attempts (canonical_url, apply_address) WHERE state = 'started';
    `),
  },
  {
    version: 6,
    name: 'the answer a sent attempt gave',
    // A Send whose response was lost is asked again with the same request
    // id, and answers what it answered the first time without calling Gmail
    // (ticket #83). The answer is kept beside its attempt, as JSON.
    up: (db) => db.exec('ALTER TABLE send_attempts ADD COLUMN answer TEXT'),
  },
]

/** The file carries a schema version this Native host does not know: a newer
 *  version of the tool wrote it. Nothing is written to it. */
export class DatabaseTooNew extends Error {
  constructor(readonly found: number, readonly known: number) {
    super(
      `The database comes from a newer version of the tool (schema version ${found}; ` +
      `this Native host knows up to ${known}). Update job-form-filler. Nothing is written to it until then.`,
    )
    this.name = 'DatabaseTooNew'
  }
}

/**
 * Brings the file up to the last migration's version. Each migration runs in
 * its own transaction, which also raises `user_version`, so it is applied once
 * or not at all. The transaction is BEGIN IMMEDIATE and the version is read
 * inside it: the write lock comes first, so a second Native host that opens the
 * file at the same moment waits, then reads the raised version and applies
 * nothing. Throws DatabaseTooNew, with nothing written, when the file's version
 * is past the list.
 */
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration "${m.name}" is numbered ${m.version}, expected ${i + 1}`)
  })
  const known = migrations.length

  const step = db.transaction((): Migration | null => {
    const current = db.pragma('user_version', { simple: true }) as number
    if (current > known) throw new DatabaseTooNew(current, known)
    const next = migrations[current]
    if (next === undefined) return null
    next.up(db)
    db.pragma(`user_version = ${next.version}`)
    return next
  })

  for (let applied = step.immediate(); applied !== null; applied = step.immediate()) {
    if (!db.memory) log('info', 'database migrated', { version: applied.version, name: applied.name })
  }
}
