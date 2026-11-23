import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { HostResponse } from '@jff/shared'
import { openDb, setProfile } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'

// Seam 1 of spec #98, ticket #103: the `generate` request through the host's
// request handler, with fake model runners. The writer may name what stored
// fact is missing beside its Draft; the reply carries that gap as `missing`.

let db: Database.Database
let deps: HandlerDeps
let writerPrompts: string[]
let writerReply: Record<string, unknown>
let checkReply: { draft: string; unsupported: string[] } | Error

const DRAFT = 'Não encontrei nos meus dados se posso trabalhar presencialmente um dia por semana.'
const GAP = 'Whether you can work on site one day a week.'

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100' })
  writerPrompts = []
  writerReply = { draft: DRAFT, missing: GAP }
  checkReply = { draft: DRAFT, unsupported: [] }
  const writer = vi.fn(async (prompt: string) => { writerPrompts.push(prompt); return writerReply })
  const checker = vi.fn(async () => {
    if (checkReply instanceof Error) throw checkReply
    return checkReply
  })
  deps = {
    db,
    runner: { complete: writer } as unknown as HandlerDeps['runner'],
    codex: { complete: checker } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

async function generate(fieldClass: 'prose' | 'personal_fact' = 'personal_fact'): Promise<HostResponse> {
  return await handleRaw(deps, {
    requestId: crypto.randomUUID(),
    method: 'generate',
    params: {
      handle: { frameId: 0, fid: 3, epoch: 1 },
      questionRaw: 'Você pode trabalhar presencialmente um dia por semana?',
      jobText: 'Acme builds payment rails.',
      company: 'Acme',
      fieldClass,
    },
  })
}

const resultOf = (r: HostResponse): Record<string, unknown> => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r.result as Record<string, unknown>
}

describe('A generate reply names what is missing', () => {
  it('carries the gap the writer named, for a Personal-fact Field and a Prose Field', async () => {
    for (const fieldClass of ['personal_fact', 'prose'] as const) {
      const result = resultOf(await generate(fieldClass))
      expect(result, fieldClass).toMatchObject({ draft: DRAFT, missing: GAP })
    }
  })

  it('asks the writer for the gap in the same call as the Draft, in English', async () => {
    await generate()
    expect(writerPrompts).toHaveLength(1)
    expect(writerPrompts[0]).toMatch(/"missing"/)
    expect(writerPrompts[0]).toMatch(/missing.*in English/i)
  })

  it('has no such field when the writer named no gap, or an empty one', async () => {
    for (const reply of [{ draft: DRAFT }, { draft: DRAFT, missing: '' }, { draft: DRAFT, missing: '   ' }, { draft: DRAFT, missing: null }]) {
      writerReply = reply
      const result = resultOf(await generate())
      expect(result, JSON.stringify(reply)).not.toHaveProperty('missing')
      expect(result.draft).toBe(DRAFT)
    }
  })

  it('cuts a gap longer than 300 characters to 300', async () => {
    writerReply = { draft: DRAFT, missing: 'x'.repeat(450) }
    const result = resultOf(await generate())
    expect(result.missing).toBe('x'.repeat(300))
  })

  it('keeps the gap when the Draft check rewrites the Draft and flags a sentence', async () => {
    const flagged = 'I live in Lisbon.'
    checkReply = { draft: `${DRAFT} ${flagged}`, unsupported: [flagged] }
    const result = resultOf(await generate())
    expect(result).toMatchObject({ draft: `${DRAFT} ${flagged}`, unsupportedClaims: [flagged], missing: GAP })
  })

  it('keeps the gap when the Draft check fails, beside the unchecked Draft', async () => {
    checkReply = new Error('codex down')
    const result = resultOf(await generate())
    expect(result).toMatchObject({ draft: DRAFT, missing: GAP })
    expect(result).not.toHaveProperty('unsupportedClaims')
  })
})
