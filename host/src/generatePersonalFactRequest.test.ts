import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { HostResponse } from '@jff/shared'
import { openDb, setProfile } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'

// Seam 1 of spec #98: the `generate` request through the host's request
// handler, with a real in-memory database and fake model runners. What is
// asserted is the instruction the writer is handed for the Field's kind, and
// the reply the Side panel receives.

let db: Database.Database
let deps: HandlerDeps
let writerPrompts: string[]
let checkPrompts: string[]
let checkReply: { draft: string; unsupported: string[] }

const writer = vi.fn()
const checker = vi.fn()

const DRAFT = 'Yes, I have worked with TypeScript 4 and 5.'

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100' })
  writerPrompts = []
  checkPrompts = []
  checkReply = { draft: DRAFT, unsupported: [] }
  writer.mockReset()
  writer.mockImplementation(async (prompt: string) => { writerPrompts.push(prompt); return { draft: DRAFT } })
  checker.mockReset()
  checker.mockImplementation(async (prompt: string) => { checkPrompts.push(prompt); return checkReply })
  deps = {
    db,
    runner: { complete: writer } as unknown as HandlerDeps['runner'],
    codex: { complete: checker } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

const QUESTION = 'Have you worked with TypeScript 5?'

const params = (extra: Record<string, unknown> = {}) => ({
  handle: { frameId: 0, fid: 3, epoch: 1 },
  questionRaw: QUESTION,
  jobText: 'Acme builds payment rails.',
  company: 'Acme',
  ...extra,
})

/** Through the host's stdin entry, which parses the request against the schema. */
async function generate(extra: Record<string, unknown> = {}): Promise<HostResponse> {
  return await handleRaw(deps, { requestId: crypto.randomUUID(), method: 'generate', params: params(extra) })
}

/** The rules a Personal-fact Field is drafted under, as the writer reads them. */
function expectPersonalFactRules(prompt: string): void {
  expect(prompt).toMatch(/one to three sentences/i)
  expect(prompt).toMatch(/language of the question/i)
  expect(prompt).toMatch(/yes\/no question.*opens? with yes or no/i)
  expect(prompt).toMatch(/no narrative/i)
  expect(prompt).toMatch(/ONLY from the CANDIDATE FACTS, CANDIDATE CV or PROJECT NOTES blocks/)
  expect(prompt).toMatch(/say what is missing.*in one sentence/i)
  // Not the prose rules: no word count, no constructive answer to a subjective question.
  expect(prompt).not.toMatch(/60 to 150 words/)
  expect(prompt).not.toMatch(/refusing a subjective question is forbidden/i)
}

describe('A generate request drafts by the kind of Field it is for', () => {
  it('hands the writer the personal-fact rules for a Personal-fact Field', async () => {
    const r = await generate({ fieldClass: 'personal_fact' })
    expect(r).toMatchObject({ ok: true, result: { draft: DRAFT } })
    expect(writerPrompts).toHaveLength(1)
    expectPersonalFactRules(writerPrompts[0]!)
  })

  it('hands the writer the prose rules, unchanged, for a Prose Field', async () => {
    const r = await generate({ fieldClass: 'prose', questionRaw: 'Why do you want to work at Acme?' })
    expect(r).toMatchObject({ ok: true })
    const prompt = writerPrompts[0]!
    expect(prompt).toMatch(/60 to 150 words/)
    expect(prompt).toMatch(/refusing a subjective question is forbidden/i)
    expect(prompt).toMatch(/If a FACTUAL question has no basis in those blocks, say what is missing plainly in one sentence/)
    expect(prompt).not.toMatch(/one to three sentences/i)
  })

  it('drafts a request with no label as a personal fact', async () => {
    const r = await generate()
    expect(r).toMatchObject({ ok: true, result: { draft: DRAFT } })
    expectPersonalFactRules(writerPrompts[0]!)
  })

  it('refuses a label outside the two values as a bad request, and calls no model', async () => {
    for (const fieldClass of ['essay', 42, null]) {
      const r = await generate({ fieldClass })
      expect(r, String(fieldClass)).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    }
    expect(writer).not.toHaveBeenCalled()
    expect(checker).not.toHaveBeenCalled()
  })
})

describe('The Draft check reads a personal-fact Draft', () => {
  it('runs on it, and a flagged sentence reaches the reply', async () => {
    const flagged = 'I need no accommodation.'
    checkReply = { draft: `${DRAFT} ${flagged}`, unsupported: [flagged] }
    const r = await generate({ fieldClass: 'personal_fact' })
    expect(checkPrompts).toHaveLength(1)
    expect(checkPrompts[0]).toContain(DRAFT)
    expect(r).toMatchObject({ ok: true, result: { draft: `${DRAFT} ${flagged}`, unsupportedClaims: [flagged] } })
  })
})
