import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField, FieldHandle, Resolution } from '@jff/shared'
import { openDb, setAnswerBank, setProfile, upsertAnswer } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'
import { normalizeQuestion } from './normalize.js'

// Ticket #28 at the Native host seam (spec #6, testing decision 2): a Saved
// answer meets the Options a single-choice Control shows at Scan. Equal to one
// Option, it fills as before; equal to none, it is not proposed and the row is
// Needs input. Where the Options are not known at Scan (a dropdown that loads
// them on open) the answer goes on to Fill, whose miss the Side panel handles.
// Requests go through the host's request handler with a real in-memory
// database and a fake Mapping runner; what is asserted is what the panel would
// receive.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string; answerId?: number }

let db: Database.Database
let deps: HandlerDeps
let mapping: ReturnType<typeof vi.fn>
let claude: ReturnType<typeof vi.fn>
let decide: (ref: string) => Decision

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100' })
  decide = () => ({ decision: 'custom' })
  mapping = vi.fn(async (prompt: string) => {
    const refs = [...prompt.matchAll(/^- ref=(\S+)/gm)].map((m) => m[1]!)
    return refs.map((ref) => {
      const d = decide(ref)
      return { ref, decision: d.decision, knownKey: d.knownKey ?? null, answerId: d.answerId ?? null }
    })
  })
  claude = vi.fn(async () => { throw new Error('claude is not part of Resolution') })
  deps = {
    db,
    runner: { complete: claude } as unknown as HandlerDeps['runner'],
    codex: { complete: mapping } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

let fid = 0
const control = (kind: EnumField['kind'], label: string, options: string[]): EnumField => ({
  frameId: 0, fid: fid++, epoch: 4, label, name: null, idAttr: null, kind,
  options, required: false, visible: true, currentValue: null, demographic: false,
})

async function send<T>(method: 'resolve.first' | 'resolve.mapping', fields: EnumField[]): Promise<T> {
  const r = await handleRequest(deps, {
    requestId: crypto.randomUUID(), method,
    params: {
      epoch: 4, url: 'https://jobs.lever.co/acme/1', hostname: 'jobs.lever.co',
      company: 'Acme', jobText: 'Engineer wanted.', fields,
    },
  })
  if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r)}`)
  return r.result as T
}

async function first(f: EnumField): Promise<Resolution | 'pending'> {
  const r = await send<{ resolutions: Resolution[]; pending: FieldHandle[] }>('resolve.first', [f])
  const decided = r.resolutions.find((x) => x.handle.fid === f.fid)
  if (decided !== undefined) return decided
  if (r.pending.some((h) => h.fid === f.fid)) return 'pending'
  throw new Error(`resolve.first neither decided nor left pending fid ${f.fid}`)
}

async function mapped(f: EnumField): Promise<Resolution> {
  return (await send<{ resolutions: Resolution[] }>('resolve.mapping', [f])).resolutions[0]!
}

function save(question: string, answer: string): number {
  return upsertAnswer(db, {
    questionNormalized: normalizeQuestion(question), questionRaw: question,
    answer, language: 'en', reusability: 'reusable',
  })
}

const BEFORE = 'Have you previously worked for this company?'
const PROSE = 'I have spent the last six years building data pipelines for analytical engines, and I would bring that experience to your team from day one.'
const YES_NO = ['Select...', 'Yes', 'No']

describe('a Saved answer on a Control whose Options are known at Scan', () => {
  it('equal to one Option of a native select, it fills that Option, as before', async () => {
    save(BEFORE, 'no')
    const r = await first(control('select', BEFORE, YES_NO))
    expect(r).toMatchObject({ tier: 'auto', source: 'saved_answer', value: 'No', reason: 'exact-match' })
  })

  it('a paragraph of prose, for a native Yes/No select, is not proposed: the row is Needs input', async () => {
    const id = save(BEFORE, PROSE)
    const r = await first(control('select', BEFORE, YES_NO))
    expect(r).toMatchObject({ tier: 'needs_input', value: null, source: null })
    expect(r).not.toMatchObject({ answerId: id })
  })

  it('the same holds for a radio group and for a dropdown whose Options the page listed', async () => {
    save(BEFORE, PROSE)
    expect(await first(control('radiogroup', BEFORE, ['Yes', 'No']))).toMatchObject({ tier: 'needs_input', value: null })
    expect(await first(control('combobox', BEFORE, ['Yes', 'No']))).toMatchObject({ tier: 'needs_input', value: null })
  })

  it('a Saved answer under a recognized question whose key has no Value meets the Options the same way', async () => {
    // Sponsorship and authorization are answered per country from workAuth,
    // never from a Saved answer (ticket #29), so the key here is relocate.
    const RELOCATE = 'Are you willing to relocate for this role?'
    save(RELOCATE, PROSE)
    expect(await first(control('select', RELOCATE, YES_NO))).toMatchObject({ tier: 'needs_input', value: null })
    save(RELOCATE, 'yes')
    expect(await first(control('select', RELOCATE, YES_NO))).toMatchObject({ tier: 'auto', source: 'saved_answer', value: 'Yes' })
  })

  it('a Saved answer Mapping reuses, equal to no Option, is not proposed either', async () => {
    const id = save('Were you ever employed here?', PROSE)
    decide = () => ({ decision: 'reuse_answer', answerId: id })
    const r = await mapped(control('select', 'Former employee?', YES_NO))
    expect(r).toMatchObject({ tier: 'needs_input', value: null })
  })

  it('a Saved answer Mapping reuses, equal to one Option, is Proposed in the page wording', async () => {
    const id = save('Were you ever employed here?', 'NO')
    decide = () => ({ decision: 'reuse_answer', answerId: id })
    const r = await mapped(control('select', 'Former employee?', YES_NO))
    expect(r).toMatchObject({ tier: 'proposed', source: 'llm_reuse', value: 'No' })
  })
})

describe('a Saved answer on a dropdown whose Options are not known at Scan', () => {
  it('goes on to Fill whole: the Options are matched there (ADR 0009)', async () => {
    save(BEFORE, PROSE)
    const r = await first(control('combobox', BEFORE, []))
    expect(r).toMatchObject({ tier: 'auto', source: 'saved_answer', value: PROSE })
  })
})

describe('a Saved answer on a text box', () => {
  it('is used whole, as before', async () => {
    save(BEFORE, PROSE)
    expect(await first(control('textarea', BEFORE, []))).toMatchObject({ tier: 'auto', value: PROSE })
  })
})
