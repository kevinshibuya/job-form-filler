import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { openDb, setProfile, getProfile, getSelector, getLearnedMapping, upsertAnswer } from './db/repos.js'
import { handleRequest, type HandlerDeps } from './handlers.js'
import { ClaudeError } from './llm/claudeCli.js'
import { CodexError } from './llm/codexCli.js'
import { resolveModels } from './llm/models.js'

let db: Database.Database
let deps: HandlerDeps

// `complete` is generic on ClaudeRunner, so a plain vi.fn needs an explicit cast.
// The mock is kept in its own binding: the cast erases the Mock type, so
// `runner.complete.mockClear()` would not typecheck through `runner`.
const complete = vi.fn(async (_prompt: string, _schema?: unknown): Promise<unknown> => [])
const runner = { complete } as unknown as HandlerDeps['runner']

const codexComplete = vi.fn(async (_prompt: string, _schema?: unknown): Promise<unknown> => ({ draft: 'reviewed' }))
const codex = { complete: codexComplete } as unknown as HandlerDeps['codex']

const genReq = (requestId: string) => ({
  requestId, method: 'generate' as const,
  params: { handle: { frameId: 0, fid: 3, epoch: 1 }, questionRaw: 'Why us?', jobText: '', company: null },
})

beforeEach(() => {
  db = openDb(':memory:')
  complete.mockClear()
  codexComplete.mockClear()
  deps = {
    db,
    runner,
    codex,
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', models: {} },
    selfCheckFn: async () => ({
      node: { ok: true, version: 'v20.0.0' },
      claude: { ok: true, path: '/bin/true', detail: 'found' },
      auth: { ok: true, detail: 'logged in' },
      db: { ok: true, path: ':memory:' },
    }),
  }
})

describe('handleRequest', () => {
  it('answers selfCheck', async () => {
    const r = await handleRequest(deps, { requestId: 'a', method: 'selfCheck', params: {} })
    expect(r).toMatchObject({ requestId: 'a', ok: true })
  })

  it('round-trips profile.set then profile.get', async () => {
    await handleRequest(deps, { requestId: 'b', method: 'profile.set', params: { values: { email: 'k@x.com' } } })
    const r = await handleRequest(deps, { requestId: 'c', method: 'profile.get', params: {} })
    expect(r).toMatchObject({ ok: true, result: { email: 'k@x.com' } })
  })

  it('rejects a profile key outside the closed set', async () => {
    const r = await handleRequest(deps, { requestId: 'd', method: 'profile.set', params: { values: { ssn: '123' } } })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect(getProfile(db)).toEqual({})
  })

  it('saves and reads a learned job_description selector', async () => {
    await handleRequest(deps, { requestId: 'e', method: 'selector.save', params: { hostname: 'x.com', purpose: 'job_description', selector: '#jd' } })
    expect(getSelector(db, 'x.com', 'job_description')).toBe('#jd')
    const r = await handleRequest(deps, { requestId: 'f', method: 'selector.get', params: { hostname: 'x.com', purpose: 'job_description' } })
    expect(r).toMatchObject({ ok: true, result: { selector: '#jd' } })
  })

  it('promotes a confirmed mapping to deterministic, normalized', async () => {
    await handleRequest(deps, { requestId: 'g', method: 'mapping.confirm', params: { label: 'Onde voce mora?', fieldKey: 'location' } })
    expect(getLearnedMapping(db, 'onde voce mora')).toBe('location')
  })

  it('replays a cached response for a repeated requestId instead of re-running work', async () => {
    setProfile(db, { email: 'first@x.com' })
    const first = await handleRequest(deps, { requestId: 'same', method: 'profile.get', params: {} })
    setProfile(db, { email: 'second@x.com' })
    const second = await handleRequest(deps, { requestId: 'same', method: 'profile.get', params: {} })
    expect(second).toEqual(first)
    expect(second).toMatchObject({ result: { email: 'first@x.com' } })
  })

  it('does NOT cache a failed response, so a genuine retry can still succeed', async () => {
    await handleRequest(deps, { requestId: 'retry', method: 'profile.set', params: { values: { ssn: 'x' } } })
    const second = await handleRequest(deps, { requestId: 'retry', method: 'profile.set', params: { values: { email: 'ok@x.com' } } })
    expect(second).toMatchObject({ ok: true })
    expect(getProfile(db)).toEqual({ email: 'ok@x.com' })
  })

  it('pages qa.list with the {page, done} convention', async () => {
    for (let i = 0; i < 3; i++) {
      upsertAnswer(db, { questionNormalized: `q${i}`, questionRaw: `Q${i}`, answer: 'a', language: 'en', reusability: 'reusable' })
    }
    const r = await handleRequest(deps, { requestId: 'h', method: 'qa.list', params: { page: 0 } })
    expect(r).toMatchObject({ ok: true, result: { page: 0, done: true } })
    expect((r as { result: { items: unknown[] } }).result.items).toHaveLength(3)
  })

  it('returns a db error rather than throwing when a repo call fails', async () => {
    db.close()
    const r = await handleRequest(deps, { requestId: 'i', method: 'profile.get', params: {} })
    expect(r).toMatchObject({ ok: false, error: { kind: 'db' } })
  })

  it('passes the generate description through to the prompt, fenced', async () => {
    complete.mockResolvedValueOnce({ draft: 'ok' })
    // Task 9: generate now pipes the claude draft through the codex reviewer
    // before returning, so the result reflects codexComplete's mocked reply.
    codexComplete.mockResolvedValueOnce({ draft: 'ok' })
    const r = await handleRequest(deps, {
      requestId: 'gen1', method: 'generate',
      params: {
        handle: { frameId: 0, fid: 3, epoch: 1 },
        questionRaw: 'Describe the outcome',
        description: 'Please include: timeline and impact',
        jobText: '', company: null,
      },
    })
    expect(r).toMatchObject({ ok: true, result: { draft: 'ok' } })
    const prompt = complete.mock.calls[0]![0] as string
    expect(prompt).toContain('<field_description>Please include: timeline and impact</field_description>')
  })

  it('pipes the claude draft through the codex reviewer and returns the sanitized reviewed draft', async () => {
    complete.mockResolvedValueOnce({ draft: 'claude draft' })
    codexComplete.mockResolvedValueOnce({ draft: 'reviewed draft — tight.' })
    const r = await handleRequest(deps, genReq('gen-r1'))
    // sanitizeDraft applies to the FINAL text: the reviewer's spaced em-dash is scrubbed.
    expect(r).toMatchObject({ ok: true, result: { draft: 'reviewed draft, tight.' } })
    expect(codexComplete.mock.calls[0]![0] as string).toContain('claude draft')
  })

  it('falls back to the unreviewed claude draft on ANY codex failure class', async () => {
    const failures = [
      Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
      new CodexError('timeout', 'codex exec exceeded 120000ms'),
      new CodexError('invalid_output', 'no JSON'),
      new CodexError('process', 'exit 1'),
    ]
    for (let i = 0; i < failures.length; i++) {
      complete.mockResolvedValueOnce({ draft: 'claude draft' })
      codexComplete.mockRejectedValueOnce(failures[i]!)
      const r = await handleRequest(deps, genReq(`gen-fb-${i}`)) // unique ids — the response cache replays repeats
      expect(r).toMatchObject({ ok: true, result: { draft: 'claude draft' } })
    }
  })

  it('a claude failure surfaces as the host error and codex is never consulted', async () => {
    complete.mockRejectedValueOnce(new ClaudeError('rate_limit', 'limit'))
    const r = await handleRequest(deps, genReq('gen-cf'))
    expect(r).toMatchObject({ ok: false, error: { kind: 'rate_limit' } })
    expect(codexComplete).not.toHaveBeenCalled()
  })

  it('facts.extract maps CV text onto the closed key set, stripping unknown keys', async () => {
    complete.mockResolvedValueOnce({ email: 'k@x.com', ssn: '123', salary: ' R$ 18k ' })
    const r = await handleRequest(deps, { requestId: 'fx1', method: 'facts.extract', params: { cvText: 'CV BODY' } })
    expect(r).toMatchObject({ ok: true, result: { email: 'k@x.com', salary: 'R$ 18k' } })
    const result = (r as { result: Record<string, string> }).result
    expect('ssn' in result).toBe(false)
    expect(complete.mock.calls[0]![0] as string).toContain('CV BODY')
  })
})

describe('applied.* (A1)', () => {
  it('mark → check round-trips through the canonical url', async () => {
    const marked = await handleRequest(deps, { requestId: 'am-1', method: 'applied.mark', params: { url: 'https://x.com/j/1?utm_source=a', company: 'Acme', jobTitle: 'Eng' } })
    expect(marked.ok).toBe(true)
    const checked = await handleRequest(deps, { requestId: 'am-2', method: 'applied.check', params: { url: 'https://x.com/j/1?utm_medium=b' } })
    expect(checked).toMatchObject({ ok: true, result: { applied: { company: 'Acme', jobTitle: 'Eng', canonicalUrl: 'x.com/j/1' } } })
  })

  it('re-marking preserves the ORIGINAL marked_at and updates the rest', async () => {
    const first = await handleRequest(deps, { requestId: 'am-3', method: 'applied.mark', params: { url: 'https://x.com/j/2', company: null, jobTitle: null } })
    const firstAt = (first as { result: { markedAt: string } }).result.markedAt
    const again = await handleRequest(deps, { requestId: 'am-4', method: 'applied.mark', params: { url: 'https://x.com/j/2/?utm_source=x', company: 'Acme', jobTitle: 'Eng II' } })
    expect((again as { result: { markedAt: string } }).result.markedAt).toBe(firstAt)
    expect(again).toMatchObject({ ok: true, result: { company: 'Acme', jobTitle: 'Eng II' } })
  })

  it('re-marking with a BLANK company keeps the company the first mark got right', async () => {
    // The panel sends `company: null` for an empty field and `jobTitle: null` for
    // an empty tab title, and both are routine on a re-mark: "Scan anyway" on a
    // step-2 url guesses no company. A plain `excluded.company` upsert NULLED the
    // stored one — a null is "nothing to say", never "erase what you know".
    const first = await handleRequest(deps, { requestId: 'am-9', method: 'applied.mark', params: { url: 'https://x.com/j/3', company: 'Acme', jobTitle: 'Eng' } })
    const firstAt = (first as { result: { markedAt: string } }).result.markedAt
    const again = await handleRequest(deps, { requestId: 'am-10', method: 'applied.mark', params: { url: 'https://x.com/j/3?utm_source=x', company: null, jobTitle: null } })
    expect(again).toMatchObject({ ok: true, result: { company: 'Acme', jobTitle: 'Eng', markedAt: firstAt } })
    const checked = await handleRequest(deps, { requestId: 'am-11', method: 'applied.check', params: { url: 'https://x.com/j/3' } })
    expect(checked).toMatchObject({ ok: true, result: { applied: { company: 'Acme', jobTitle: 'Eng' } } })
  })

  it('check misses on a different job', async () => {
    const r = await handleRequest(deps, { requestId: 'am-5', method: 'applied.check', params: { url: 'https://x.com/j/999' } })
    expect(r).toMatchObject({ ok: true, result: { applied: null } })
  })

  it('list returns newest-first', async () => {
    await handleRequest(deps, { requestId: 'am-6', method: 'applied.mark', params: { url: 'https://x.com/j/a', company: null, jobTitle: 'A' } })
    await handleRequest(deps, { requestId: 'am-7', method: 'applied.mark', params: { url: 'https://x.com/j/b', company: null, jobTitle: 'B' } })
    const r = await handleRequest(deps, { requestId: 'am-8', method: 'applied.list', params: {} })
    const jobs = (r as { result: { jobs: { jobTitle: string }[] } }).result.jobs
    expect(jobs.map((j) => j.jobTitle)).toEqual(['B', 'A'])
  })
})
