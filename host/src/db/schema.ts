import type Database from 'better-sqlite3'

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS profile (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS answer_bank (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qa_memory (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  question_normalized TEXT NOT NULL,
  question_raw        TEXT NOT NULL,
  answer              TEXT NOT NULL,
  language            TEXT NOT NULL CHECK (language IN ('en','pt')),
  reusability         TEXT NOT NULL CHECK (reusability IN ('reusable','company_specific')),
  times_used          INTEGER NOT NULL DEFAULT 0,
  last_used_at        TEXT,
  source_url          TEXT,
  UNIQUE (question_normalized, language)
);

CREATE TABLE IF NOT EXISTS learned_mappings (
  label_normalized TEXT PRIMARY KEY,
  field_key        TEXT NOT NULL,
  confirmed_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learned_selectors (
  hostname TEXT NOT NULL,
  purpose  TEXT NOT NULL,
  selector TEXT NOT NULL,
  PRIMARY KEY (hostname, purpose)
);

CREATE TABLE IF NOT EXISTS applications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT NOT NULL,
  company         TEXT,
  applied_at      TEXT NOT NULL,
  filled_count    INTEGER NOT NULL,
  generated_count INTEGER NOT NULL
);

-- Idempotency ledger: a requestId already answered replays its stored response
-- instead of re-running a paid claude -p call.
CREATE TABLE IF NOT EXISTS request_log (
  request_id    TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
`

export function migrate(db: Database.Database): void {
  db.exec(SCHEMA_SQL)
}
