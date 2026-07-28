import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import {
  openDb, getProfile, setProfile, getAnswerBank, setAnswerBank, getStoredValue,
  findExactAnswer, listReusableAnswers, listReferenceAnswers, getAnswerById,
  upsertAnswer, touchAnswer, getLearnedMapping, saveLearnedMapping,
  getSelector, saveSelector, insertApplication, getCachedResponse, putCachedResponse,
  pruneRequestLog,
} from './repos.js'

let db: Database.Database
beforeEach(() => { db = openDb(':memory:') })

describe('profile + answer bank', () => {
  it('round-trips values and routes getStoredValue by key ownership', () => {
    setProfile(db, { email: 'kevin@example.com', firstName: 'Kevin' })
    setAnswerBank(db, { salary: 'R$ 18.000/mo', workAuth: 'Brazilian citizen' })
    expect(getProfile(db)).toEqual({ email: 'kevin@example.com', firstName: 'Kevin' })
    expect(getAnswerBank(db)).toEqual({ salary: 'R$ 18.000/mo', workAuth: 'Brazilian citizen' })
    expect(getStoredValue(db, 'email')).toBe('kevin@example.com')
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
    upsertAnswer(db, { ...base, questionRaw: 'Why Figma?', answer: 'I love design tools', questionNormalized: 'why figma', reusability: 'company_specific' })
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
