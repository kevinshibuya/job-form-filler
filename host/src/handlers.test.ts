import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { openDb, setProfile, getProfile, getSelector, getLearnedMapping, upsertAnswer } from './db/repos.js'
import { handleRequest, type HandlerDeps } from './handlers.js'

let db: Database.Database
let deps: HandlerDeps

// `complete` is generic on ClaudeRunner, so a plain vi.fn needs an explicit cast.
// The mock is kept in its own binding: the cast erases the Mock type, so
// `runner.complete.mockClear()` would not typecheck through `runner`.
const complete = vi.fn(async (_prompt: string, _schema?: unknown): Promise<unknown> => [])
const runner = { complete } as unknown as HandlerDeps['runner']

beforeEach(() => {
  db = openDb(':memory:')
  complete.mockClear()
  deps = {
    db,
    runner,
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json' },
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
})
