import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { AppliedTexts, HostResponse, KeptProseAnswer } from '@jff/shared'
import { listKeptProseAnswers, markApplied, openDb } from './db/repos.js'
import { MIGRATIONS } from './db/migrations.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

/**
 * Ticket #107, at the Native host's request seam: an Applied job keeps the
 * answers to questions about the user beside the prose answers, each with its
 * kind. A kept answer with no kind, on a request or in a record written before
 * the kind was kept, reads as prose.
 */

let db: Database.Database
let deps: HandlerDeps
const dirs: string[] = []

beforeEach(() => {
  db = openDb(':memory:')
  deps = {
    db,
    runner: { complete: vi.fn() } as unknown as HandlerDeps['runner'],
    codex: { complete: vi.fn() } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const WHY: KeptProseAnswer = {
  question: 'Why do you want to work here?', text: 'I read the analytical engine notes and changed two lines.',
  aiDrafted: true, edited: true, model: 'claude-opus-5-5', kind: 'prose',
}
const VERSIONS: KeptProseAnswer = {
  question: 'Which versions of the analytical engine have you worked with?', text: 'The first and the second.',
  aiDrafted: true, edited: false, model: 'claude-opus-5-5', kind: 'personal_fact',
}
const ON_SITE: KeptProseAnswer = {
  question: 'Can you work on site one day a week?', text: 'Yes, on Tuesdays.',
  aiDrafted: false, edited: false, model: null, kind: 'personal_fact',
}

let seq = 0
const send = async (method: string, params: Record<string, unknown>): Promise<HostResponse> =>
  await handleRaw(deps, { requestId: `kind-${++seq}`, method, params })

const result = <T>(r: HostResponse): T => {
  if (!r.ok) throw new Error(`request failed: ${r.error.kind}: ${r.error.message}`)
  return r.result as T
}

const markForm = async (proseAnswers: unknown[]): Promise<number> =>
  result<{ id: number }>(await send('applied.mark', {
    url: `https://jobs.example.com/${++seq}`, company: 'Acme', jobTitle: 'Engineer', channel: 'form', proseAnswers,
  })).id

describe('applied.mark keeps each answer with its kind', () => {
  it('stores prose and personal-fact answers with their kinds and returns them when the Applied job is read', async () => {
    const id = await markForm([WHY, VERSIONS, ON_SITE])
    expect(listKeptProseAnswers(db, id)).toEqual([WHY, VERSIONS, ON_SITE])
    const texts = result<AppliedTexts>(await send('applied.get', { id }))
    expect(texts.proseAnswers).toEqual([WHY, VERSIONS, ON_SITE])
  })

  it('stores an answer whose request names no kind as prose', async () => {
    const { kind: _kind, ...noKind } = VERSIONS
    const id = await markForm([noKind, ON_SITE])
    const texts = result<AppliedTexts>(await send('applied.get', { id }))
    expect(texts.proseAnswers).toEqual([{ ...VERSIONS, kind: 'prose' }, ON_SITE])
  })

  it('refuses a kind other than prose or personal fact', async () => {
    const r = await send('applied.mark', {
      url: 'https://jobs.example.com/odd', company: null, jobTitle: null, channel: 'form',
      proseAnswers: [{ ...WHY, kind: 'demographic' }],
    })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
  })

  it('reads the marks AI-drafted, edited and model as before, for both kinds', async () => {
    const answers: KeptProseAnswer[] = (['prose', 'personal_fact'] as const).flatMap((kind) => [
      { question: `Drafted and edited (${kind})`, text: 'Edited text.', aiDrafted: true, edited: true, model: 'claude-opus-5-5', kind },
      { question: `Drafted and kept (${kind})`, text: 'Kept Draft.', aiDrafted: true, edited: false, model: 'claude-sonnet-5-5', kind },
      { question: `Written by hand (${kind})`, text: 'My own words.', aiDrafted: false, edited: false, model: null, kind },
    ])
    const id = await markForm(answers)
    expect(result<AppliedTexts>(await send('applied.get', { id })).proseAnswers).toEqual(answers)
  })
})

describe('a database made before kinds were kept', () => {
  it('migrates, keeps its answers and reads them as prose', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jff-kind-'))
    dirs.push(dir)
    const path = join(dir, 'db.sqlite')
    const before = openDb(path, MIGRATIONS.slice(0, 7))
    const job = before.prepare(
      `INSERT INTO applied_jobs (url, canonical_url, company, job_title, marked_at, channel)
       VALUES ('https://jobs.example.com/1', 'jobs.example.com/1', 'Acme', 'Engineer', '2026-11-01T00:00:00Z', 'form')`,
    ).run()
    const jobId = Number(job.lastInsertRowid)
    before.prepare(
      `INSERT INTO applied_prose_answers (applied_job_id, position, question, text, ai_drafted, edited, model)
       VALUES (?, 0, ?, ?, 1, 1, 'claude-opus-5-5'), (?, 1, 'Tell us about a project you led', 'I wrote the first published algorithm.', 0, 0, NULL)`,
    ).run(jobId, WHY.question, WHY.text, jobId)
    before.close()

    const after = openDb(path)
    expect(after.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(listKeptProseAnswers(after, jobId)).toEqual([
      WHY,
      { question: 'Tell us about a project you led', text: 'I wrote the first published algorithm.', aiDrafted: false, edited: false, model: null, kind: 'prose' },
    ])
    // The migrated table takes a personal-fact answer on the next mark.
    markApplied(after, { url: 'https://jobs.example.com/1', company: null, jobTitle: null, channel: 'form', proseAnswers: [ON_SITE] })
    expect(listKeptProseAnswers(after, jobId)).toEqual([ON_SITE])
    after.close()
  })

  it('refuses a stored kind other than prose or personal fact', () => {
    const id = markApplied(db, { url: 'https://jobs.example.com/check', company: null, jobTitle: null, channel: 'form', proseAnswers: [WHY] }).id
    expect(() => db.prepare(`UPDATE applied_prose_answers SET kind = 'demographic' WHERE applied_job_id = ?`).run(id)).toThrow(/CHECK/)
  })
})
