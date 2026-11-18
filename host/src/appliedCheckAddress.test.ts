import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { HandedOverEmail, HostResponse } from '@jff/shared'
import { openDb } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

/**
 * The Revisit lookup by Apply address (spec #66, ticket #76), at the Native
 * host's request seam: an in-memory database and the request handler called
 * directly. `applied.check` takes the page's candidate addresses and answers
 * the Applied job whose Application email went to one of them, whatever the
 * case, beside its answer by Canonical URL.
 */

let db: Database.Database
let deps: HandlerDeps

beforeEach(() => {
  db = openDb(':memory:')
  const unused = { complete: vi.fn(async () => { throw new Error('no model call here') }) }
  deps = {
    db,
    runner: unused as unknown as HandlerDeps['runner'],
    codex: unused as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

const HANDED: HandedOverEmail = {
  applyAddress: 'jobs@example.org',
  subject: 'Application: Analyst — Ada Lovelace',
  body: 'Hello,\n\nI would like to apply for the analyst role.\n\nBest regards,\nAda Lovelace',
  language: 'en',
  aiDrafted: true,
  edited: false,
  model: 'claude-opus-5-5',
}

interface Job { id: number; company: string | null; jobTitle: string | null; markedAt: string; canonicalUrl: string }
interface Checked { applied: Job | null; appliedByAddress: Job | null }

let seq = 0
const send = async (method: string, params: Record<string, unknown>): Promise<HostResponse> =>
  await handleRaw(deps, { requestId: `${method}-${++seq}`, method, params })

const result = <T>(r: HostResponse): T => {
  if (!r.ok) throw new Error(`request failed: ${r.error.kind}: ${r.error.message}`)
  return r.result as T
}

const check = async (params: Record<string, unknown>): Promise<Checked> => result(await send('applied.check', params))

/** An Applied job marked after "Open in my mail app", which keeps the Apply address. */
const mailedFrom = async (url: string, email: HandedOverEmail = HANDED): Promise<Job> =>
  result(await send('applied.mark', { url, company: 'Acme', jobTitle: 'Analyst', channel: 'email', email }))

describe('applied.check with the page\'s Apply addresses', () => {
  it('answers the Applied job whose Application email went to one of them', async () => {
    const job = await mailedFrom('https://careers.example.com/jobs/1')
    const got = await check({ url: 'https://board.example.net/postings/77', applyAddresses: ['privacy@example.org', 'jobs@example.org'] })
    expect(got.appliedByAddress).toMatchObject({ id: job.id, company: 'Acme', jobTitle: 'Analyst', markedAt: job.markedAt })
    // The page is not that Applied job: the Canonical URL answer is still no.
    expect(got.applied).toBeNull()
  })

  it('compares addresses without regard to case, both ways', async () => {
    const job = await mailedFrom('https://careers.example.com/jobs/1', { ...HANDED, applyAddress: 'Jobs@Example.ORG' })
    expect((await check({ url: 'https://board.example.net/p/1', applyAddresses: ['JOBS@example.org'] })).appliedByAddress?.id).toBe(job.id)
    expect((await check({ url: 'https://board.example.net/p/1', applyAddresses: ['jobs@example.org'] })).appliedByAddress?.id).toBe(job.id)
  })

  it('answers null for the addresses when no Application email went to them, and the Canonical URL as before', async () => {
    const job = await mailedFrom('https://careers.example.com/jobs/1')
    const got = await check({ url: 'https://careers.example.com/jobs/1?utm_source=x', applyAddresses: ['privacy@example.org'] })
    expect(got.appliedByAddress).toBeNull()
    expect(got.applied?.id).toBe(job.id)
  })

  it('answers null for the addresses with an empty list or none at all', async () => {
    await mailedFrom('https://careers.example.com/jobs/1')
    expect((await check({ url: 'https://board.example.net/p/1', applyAddresses: [] })).appliedByAddress).toBeNull()
    expect((await check({ url: 'https://board.example.net/p/1' })).appliedByAddress).toBeNull()
  })

  it('never matches a form Applied job, which has no Application email', async () => {
    await send('applied.mark', { url: 'https://careers.example.com/jobs/2', company: 'Acme', jobTitle: 'Analyst' })
    expect((await check({ url: 'https://board.example.net/p/1', applyAddresses: ['jobs@example.org'] })).appliedByAddress).toBeNull()
  })

  it('answers the latest Applied job when two went to the same address', async () => {
    await mailedFrom('https://careers.example.com/jobs/1')
    const second = await mailedFrom('https://careers.example.com/jobs/2')
    expect((await check({ url: 'https://board.example.net/p/1', applyAddresses: ['jobs@example.org'] })).appliedByAddress?.id).toBe(second.id)
  })

  it('refuses an address list that is not a list of strings', async () => {
    const r = await send('applied.check', { url: 'https://board.example.net/p/1', applyAddresses: 'jobs@example.org' })
    expect(r.ok).toBe(false)
  })
})
