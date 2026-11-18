import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { MIGRATIONS } from './migrations.js'
import {
  openDb, getProfile, setProfile, getAnswerBank, setAnswerBank, getStoredValue,
  findExactAnswer, listReusableAnswers, listReferenceAnswers, getAnswerById,
  upsertAnswer, touchAnswer, getLearnedMapping, saveLearnedMapping,
  getSelector, saveSelector, insertApplication, getCachedResponse, putCachedResponse,
  pruneRequestLog, saveLearnedWording, getLearnedWordings,
} from './repos.js'

let db: Database.Database
beforeEach(() => { db = openDb(':memory:') })

describe('profile + answer bank', () => {
  it('round-trips values and routes getStoredValue by key ownership', () => {
    setProfile(db, { email: 'ada@example.com', firstName: 'Ada' })
    setAnswerBank(db, { salary: 'R$ 18.000/mo', workAuth: 'Brazilian citizen' })
    expect(getProfile(db)).toEqual({ email: 'ada@example.com', firstName: 'Ada' })
    expect(getAnswerBank(db)).toEqual({ salary: 'R$ 18.000/mo', workAuth: 'Brazilian citizen' })
    expect(getStoredValue(db, 'email')).toBe('ada@example.com')
    expect(getStoredValue(db, 'salary')).toBe('R$ 18.000/mo')
    expect(getStoredValue(db, 'github')).toBeNull()
  })

  it('setProfile upserts rather than duplicating', () => {
    setProfile(db, { email: 'a@b.c' })
    setProfile(db, { email: 'd@e.f' })
    expect(getStoredValue(db, 'email')).toBe('d@e.f')
  })
})

describe('qa_memory', () => {
  const base = { questionRaw: 'How many years of React?', answer: '6 years', language: 'en' as const, sourceUrl: 'https://x' }

  it('upserts by (question_normalized, language) and finds an exact match', () => {
    const id = upsertAnswer(db, { ...base, questionNormalized: 'how many years of react', reusability: 'reusable' })
    const again = upsertAnswer(db, { ...base, answer: '7 years', questionNormalized: 'how many years of react', reusability: 'reusable' })
    expect(again).toBe(id)
    expect(findExactAnswer(db, 'how many years of react', 'en')!.answer).toBe('7 years')
  })

  it('keeps EN and PT rows for the same normalized question separate', () => {
    upsertAnswer(db, { ...base, questionNormalized: 'q', reusability: 'reusable' })
    upsertAnswer(db, { ...base, language: 'pt', answer: '6 anos', questionNormalized: 'q', reusability: 'reusable' })
    expect(findExactAnswer(db, 'q', 'en')!.answer).toBe('6 years')
    expect(findExactAnswer(db, 'q', 'pt')!.answer).toBe('6 anos')
  })

  it('listReusableAnswers excludes company_specific rows (company-specificity guard)', () => {
    upsertAnswer(db, { ...base, questionNormalized: 'reusable q', reusability: 'reusable' })
    upsertAnswer(db, { ...base, questionRaw: 'Why Acme?', answer: 'I love design tools', questionNormalized: 'why acme', reusability: 'company_specific' })
    const reusable = listReusableAnswers(db, 'en')
    expect(reusable.map((r) => r.questionNormalized)).toEqual(['reusable q'])
  })

  it('listReferenceAnswers returns company_specific rows for the same question, for [Generate] seeding only', () => {
    upsertAnswer(db, { ...base, questionRaw: 'Why this company?', answer: 'prior draft', questionNormalized: 'why this company', reusability: 'company_specific' })
    expect(listReferenceAnswers(db, 'why this company', 'en').map((r) => r.answer)).toEqual(['prior draft'])
    expect(listReferenceAnswers(db, 'unrelated', 'en')).toEqual([])
  })

  it('touchAnswer increments times_used and stamps last_used_at', () => {
    const id = upsertAnswer(db, { ...base, questionNormalized: 'q', reusability: 'reusable' })
    touchAnswer(db, id)
    touchAnswer(db, id)
    const row = getAnswerById(db, id)!
    expect(row.timesUsed).toBe(2)
    expect(row.lastUsedAt).not.toBeNull()
  })
})

describe('learned mappings and selectors', () => {
  it('round-trips a learned label to key mapping', () => {
    expect(getLearnedMapping(db, 'onde voce mora')).toBeNull()
    saveLearnedMapping(db, 'onde voce mora', 'location')
    expect(getLearnedMapping(db, 'onde voce mora')).toBe('location')
  })

  it('round-trips a per-hostname job_description selector and overwrites on re-save', () => {
    saveSelector(db, 'jobs.acme.com', 'job_description', '#jd')
    saveSelector(db, 'jobs.acme.com', 'job_description', '.jd-body')
    expect(getSelector(db, 'jobs.acme.com', 'job_description')).toBe('.jd-body')
    expect(getSelector(db, 'other.com', 'job_description')).toBeNull()
  })
})

describe('learned wordings', () => {
  it('round-trips the wordings learned for one key and Value, each once, and none for another Value or key', () => {
    expect(getLearnedWordings(db, 'relocate', 'yes')).toEqual([])
    saveLearnedWording(db, 'relocate', 'yes', 'Yes, I am open to relocating')
    saveLearnedWording(db, 'relocate', 'yes', 'Yes, I am open to relocating')
    saveLearnedWording(db, 'relocate', 'yes', 'Sim, aceito mudar')
    expect(getLearnedWordings(db, 'relocate', 'yes')).toEqual(['Yes, I am open to relocating', 'Sim, aceito mudar'])
    expect(getLearnedWordings(db, 'relocate', 'no')).toEqual([])
    expect(getLearnedWordings(db, 'workAuth', 'yes')).toEqual([])
  })

  it('a database created before the store existed opens, gains it, and keeps its data', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jff-repos-')), 'db.sqlite')
    // The schema as it stood before versioning is migration 1 alone.
    const old = openDb(path, MIGRATIONS.slice(0, 1))
    // The database as it was before ticket #35: no learned_wordings table.
    old.exec('DROP TABLE learned_wordings')
    // ...and no schema version: versioned migrations (ticket #68) came later.
    old.pragma('user_version = 0')
    setProfile(old, { email: 'ada@example.com', fullName: 'Ada Lovelace' })
    setAnswerBank(old, { relocate: 'yes' })
    upsertAnswer(old, { questionNormalized: 'q', questionRaw: 'Q?', answer: 'A', language: 'en', reusability: 'reusable' })
    old.close()

    const reopened = openDb(path)
    expect(getProfile(reopened)).toEqual({ email: 'ada@example.com', fullName: 'Ada Lovelace' })
    expect(getAnswerBank(reopened)).toEqual({ relocate: 'yes' })
    expect(findExactAnswer(reopened, 'q', 'en')!.answer).toBe('A')
    saveLearnedWording(reopened, 'relocate', 'yes', 'Yes, I am open to relocating')
    expect(getLearnedWordings(reopened, 'relocate', 'yes')).toEqual(['Yes, I am open to relocating'])
    reopened.close()
  })
})

describe('applications and request idempotency', () => {
  it('inserts an application row', () => {
    const id = insertApplication(db, { url: 'https://x/apply', company: 'Acme', filledCount: 9, generatedCount: 2 })
    expect(id).toBeGreaterThan(0)
  })

  it('caches a response by requestId and replays it verbatim', () => {
    expect(getCachedResponse(db, 'r1')).toBeNull()
    putCachedResponse(db, 'r1', '{"ok":true}')
    putCachedResponse(db, 'r1', '{"ok":false}') // first write wins; a replay must not overwrite
    expect(getCachedResponse(db, 'r1')).toBe('{"ok":true}')
  })

  it('prunes request_log rows older than the cutoff so the ledger cannot grow forever', () => {
    putCachedResponse(db, 'old', '{"ok":true}')
    db.prepare(`UPDATE request_log SET created_at = '2020-01-01T00:00:00.000Z' WHERE request_id = 'old'`).run()
    putCachedResponse(db, 'fresh', '{"ok":true}')
    pruneRequestLog(db, '2025-01-01T00:00:00.000Z')
    expect(getCachedResponse(db, 'old')).toBeNull()
    expect(getCachedResponse(db, 'fresh')).toBe('{"ok":true}')
  })
})
