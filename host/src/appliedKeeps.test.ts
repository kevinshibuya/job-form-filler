import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { HostResponse, KeptProseAnswer } from '@jff/shared'
import { listKeptProseAnswers, openDb } from './db/repos.js'
import { handleRaw, handleRequest, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

/**
 * What an Applied job keeps (spec #66), at the Native host's request seam: an
 * in-memory database, the request handler called directly, and fake runners.
 */

let db: Database.Database
let deps: HandlerDeps

const complete = vi.fn(async (_prompt: string, _schema?: unknown): Promise<unknown> => ({ draft: 'claude draft' }))
const codexComplete = vi.fn(async (_prompt: string, _schema?: unknown): Promise<unknown> => ({ draft: 'reviewed draft' }))

beforeEach(() => {
  db = openDb(':memory:')
  complete.mockClear()
  codexComplete.mockClear()
  deps = {
    db,
    runner: { complete } as unknown as HandlerDeps['runner'],
    codex: { complete: codexComplete } as unknown as HandlerDeps['codex'],
    models: resolveModels({ generate: 'claude-test-writer' }),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

const WHY: KeptProseAnswer = {
  question: 'Why do you want to work here?', text: 'I read the analytical engine notes and changed two lines.',
  aiDrafted: true, edited: true, model: 'claude-opus-5-5', kind: 'prose',
}
const PROJECT: KeptProseAnswer = {
  question: 'Tell us about a project you led', text: 'I wrote the first published algorithm.',
  aiDrafted: false, edited: false, model: null, kind: 'prose',
}

let seq = 0
const mark = async (params: Record<string, unknown>): Promise<HostResponse> =>
  await handleRaw(deps, { requestId: `mark-${++seq}`, method: 'applied.mark', params })

const result = <T>(r: HostResponse): T => {
  if (!r.ok) throw new Error(`request failed: ${r.error.kind}: ${r.error.message}`)
  return r.result as T
}

describe('applied.mark keeps a form application\'s prose answers', () => {
  it('stores each prose answer with its question, its final text and its three marks', async () => {
    const job = result<{ id: number; channel: string }>(await mark({
      url: 'https://jobs.example.com/1', company: 'Acme', jobTitle: 'Engineer', channel: 'form', proseAnswers: [WHY, PROJECT],
    }))
    expect(job.channel).toBe('form')
    expect(listKeptProseAnswers(db, job.id)).toEqual([WHY, PROJECT])
  })

  it('reads a mark with no channel as a form mark, and keeps nothing when it carries no prose answers', async () => {
    const job = result<{ id: number; channel: string }>(await mark({ url: 'https://jobs.example.com/2', company: null, jobTitle: null }))
    expect(job.channel).toBe('form')
    expect(listKeptProseAnswers(db, job.id)).toEqual([])
  })

  it('stores nothing for a prose answer with no text', async () => {
    const job = result<{ id: number }>(await mark({
      url: 'https://jobs.example.com/3', company: null, jobTitle: null,
      proseAnswers: [{ ...PROJECT, text: '   ' }, WHY],
    }))
    expect(listKeptProseAnswers(db, job.id)).toEqual([WHY])
  })

  it('refuses a channel other than form or email', async () => {
    const r = await mark({ url: 'https://jobs.example.com/4', company: null, jobTitle: null, channel: 'fax' })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
  })

  it('keeps the first date on a later mark of the same Job posting, takes the latest channel and replaces the prose answers', async () => {
    const first = result<{ id: number; markedAt: string }>(await mark({
      url: 'https://jobs.example.com/5?utm_source=a', company: 'Acme', jobTitle: 'Engineer', channel: 'form', proseAnswers: [WHY, PROJECT],
    }))
    const replacement: KeptProseAnswer = { ...WHY, text: 'A second application, written again.', edited: false }
    const again = result<{ id: number; markedAt: string; channel: string }>(await mark({
      url: 'https://jobs.example.com/5', company: null, jobTitle: null, channel: 'email', proseAnswers: [replacement],
    }))
    expect(again.id).toBe(first.id)
    expect(again.markedAt).toBe(first.markedAt)
    expect(again.channel).toBe('email')
    expect(listKeptProseAnswers(db, first.id)).toEqual([replacement])
  })

  it('keeps a form application\'s prose answers through a later email mark that carries none', async () => {
    // The texts were sent to an employer; an email mark has nothing to replace them with.
    const first = result<{ id: number }>(await mark({
      url: 'https://jobs.example.com/6', company: 'Acme', jobTitle: 'Engineer', channel: 'form', proseAnswers: [WHY],
    }))
    result(await mark({
      url: 'https://jobs.example.com/6', company: null, jobTitle: null,
      email: { applyAddress: 'jobs@example.org', subject: 'Application: Engineer', body: 'Hello,\n\nAda Lovelace', language: 'en', aiDrafted: true, edited: false, model: 'claude-opus-5-5' },
    }))
    expect(listKeptProseAnswers(db, first.id)).toEqual([WHY])
  })

  it('lists each Applied job with its channel and none of the stored texts', async () => {
    await mark({ url: 'https://jobs.example.com/6', company: 'Acme', jobTitle: 'A', channel: 'form', proseAnswers: [WHY] })
    await mark({ url: 'https://jobs.example.com/7', company: 'Acme', jobTitle: 'B', channel: 'email' })
    const r = await handleRequest(deps, { requestId: 'list-1', method: 'applied.list', params: {} })
    const { jobs } = result<{ jobs: Record<string, unknown>[] }>(r)
    expect(jobs.map((j) => [j.jobTitle, j.channel])).toEqual([['B', 'email'], ['A', 'form']])
    expect(JSON.stringify(r)).not.toContain(WHY.text)
    expect(JSON.stringify(r)).not.toContain(WHY.question)
  })
})

describe('generate names the model that wrote the Draft', () => {
  it('replies with the Generation model beside the Draft', async () => {
    const r = await handleRequest(deps, {
      requestId: 'gen-model-1', method: 'generate',
      params: { handle: { frameId: 0, fid: 3, epoch: 1 }, questionRaw: 'Why us?', jobText: '', company: null },
    })
    expect(r).toMatchObject({ ok: true, result: { draft: 'reviewed draft', model: 'claude-test-writer' } })
  })

  it('names the model on a Draft the Draft check could not review too', async () => {
    codexComplete.mockRejectedValueOnce(new Error('spawn codex ENOENT'))
    const r = await handleRequest(deps, {
      requestId: 'gen-model-2', method: 'generate',
      params: { handle: { frameId: 0, fid: 3, epoch: 1 }, questionRaw: 'Why us?', jobText: '', company: null },
    })
    expect(r).toMatchObject({ ok: true, result: { draft: 'claude draft', model: 'claude-test-writer' } })
  })
})
