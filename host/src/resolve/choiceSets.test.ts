import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { optionSetValue, type EnumField, type FieldHandle, type Resolution } from '@jff/shared'
import { openDb, setAnswerBank, setProfile, upsertAnswer } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'
import { normalizeQuestion } from './normalize.js'

// A checkbox group answered from a Saved answer that holds a set of Option
// labels. Requests go through the host's request handler with a real in-memory
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
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

let fid = 0
const group = (label: string, options: string[], extra: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid: fid++, epoch: 4, label, name: null, idAttr: null, kind: 'checkboxgroup',
  options, required: false, visible: true, currentValue: null, demographic: false, ...extra,
})
const textBox = (label: string): EnumField => ({ ...group(label, []), kind: 'text' })

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

const PENDING = 'pending' as const

async function first(f: EnumField): Promise<Resolution | typeof PENDING> {
  const r = await send<{ resolutions: Resolution[]; pending: FieldHandle[] }>('resolve.first', [f])
  const decided = r.resolutions.find((x) => x.handle.fid === f.fid)
  if (decided !== undefined) return decided
  if (r.pending.some((h) => h.fid === f.fid)) return PENDING
  throw new Error(`resolve.first neither decided nor left pending fid ${f.fid}`)
}

async function mapped(f: EnumField): Promise<Resolution> {
  return (await send<{ resolutions: Resolution[] }>('resolve.mapping', [f])).resolutions[0]!
}

const modelCalls = (): number => mapping.mock.calls.length + claude.mock.calls.length

function save(question: string, answer: string, reusability: 'reusable' | 'company_specific' = 'reusable'): number {
  return upsertAnswer(db, {
    questionNormalized: normalizeQuestion(question), questionRaw: question,
    answer, language: 'en', reusability,
  })
}

const SOURCE = 'How did you hear about us?'
const TWO = optionSetValue(['LinkedIn', 'Employee Referral'])

describe('a Saved answer of Option labels matched exactly on the question', () => {
  beforeEach(() => { save(SOURCE, TWO) })

  it('every stored label offered: auto-fill with the whole set, in resolve.first and with no model call', async () => {
    const r = await first(group(SOURCE, ['LinkedIn', 'Indeed', 'Employee Referral', 'Other']))
    expect(r).toMatchObject({ tier: 'auto', source: 'saved_answer', value: TWO })
    expect(modelCalls()).toBe(0)
  })

  it('only one stored label offered: Proposed with that one Option as its Value', async () => {
    const r = await first(group(SOURCE, ['LinkedIn', 'Indeed', 'Other']))
    expect(r).toMatchObject({ tier: 'proposed', source: 'saved_answer', value: 'LinkedIn' })
    expect(modelCalls()).toBe(0)
  })

  it('no stored label offered: Needs input with no Value', async () => {
    const r = await first(group(SOURCE, ['Indeed', 'Glassdoor', 'Other']))
    expect(r).toMatchObject({ tier: 'needs_input', value: null })
    expect(modelCalls()).toBe(0)
  })

  it('labels that differ only in case or spacing are equal, and the Value carries the page spelling', async () => {
    const r = await first(group(SOURCE, ['linkedin', '  EMPLOYEE   referral ', 'Other']))
    expect(r).toMatchObject({ tier: 'auto', value: optionSetValue(['linkedin', '  EMPLOYEE   referral ']) })
  })

  it('labels that differ in wording are not equal', async () => {
    const r = await first(group(SOURCE, ['LinkedIn', 'Referral from an employee', 'Other']))
    expect(r).toMatchObject({ tier: 'proposed', value: 'LinkedIn' })
  })

  it('the Value lists the matched Options in page order, not in stored order', async () => {
    const r = await first(group(SOURCE, ['Employee Referral', 'LinkedIn']))
    expect(r).toMatchObject({ tier: 'auto', value: optionSetValue(['Employee Referral', 'LinkedIn']) })
  })
})

describe('a Saved answer from a text box', () => {
  it('counts as a set of one label', async () => {
    save('Preferred work setting', 'Remote')
    const r = await first(group('Preferred work setting', ['On-site', 'Hybrid', 'remote']))
    expect(r).toMatchObject({ tier: 'auto', source: 'saved_answer', value: 'remote' })
  })
})

describe('a company-specific Saved answer', () => {
  it('never fills a group, on an exact match or through Mapping', async () => {
    const id = save(SOURCE, TWO, 'company_specific')
    const f = group(SOURCE, ['LinkedIn', 'Employee Referral'])
    expect(await first(f)).toBe(PENDING)
    decide = () => ({ decision: 'reuse_answer', answerId: id })
    const r = await mapped(f)
    expect(r).toMatchObject({ value: null })
    expect(r.tier).toBe('needs_input')
  })
})

describe('a Saved answer Mapping points at for a group', () => {
  let id: number
  beforeEach(() => {
    id = save('Where did you find this role?', TWO)
    decide = () => ({ decision: 'reuse_answer', answerId: id })
  })

  it('every stored label offered: Proposed with the whole set, never auto-fill', async () => {
    const f = group(SOURCE, ['LinkedIn', 'Employee Referral', 'Other'])
    expect(await first(f)).toBe(PENDING)
    expect(await mapped(f)).toMatchObject({ tier: 'proposed', source: 'llm_reuse', value: TWO, answerId: id })
  })

  it('some stored labels offered: Proposed with the matching Options', async () => {
    expect(await mapped(group(SOURCE, ['employee referral', 'Other']))).toMatchObject({
      tier: 'proposed', source: 'llm_reuse', value: 'employee referral',
    })
  })

  it('no stored label offered: Needs input with no Value', async () => {
    expect(await mapped(group(SOURCE, ['Indeed', 'Other']))).toMatchObject({ tier: 'needs_input', value: null })
  })
})

describe('a group under a Known key Mapping names', () => {
  it('only an Option equal to the stored Value is proposed, in the page spelling', async () => {
    setAnswerBank(db, { pronouns: 'she/her' })
    decide = () => ({ decision: 'known_key', knownKey: 'pronouns' })
    expect(await mapped(group('How should we address you?', ['He/him', 'She/Her', 'They/them']))).toMatchObject({
      tier: 'proposed', key: 'pronouns', value: 'She/Her',
    })
    expect(await mapped(group('How should we address you?', ['He/him', 'They/them']))).toMatchObject({
      tier: 'needs_input', value: null,
    })
  })
})

describe('pronouns', () => {
  beforeEach(() => { setAnswerBank(db, { pronouns: 'she/her' }) })

  it('stored "she/her" resolves a pronoun group offering "She/her" as auto-fill with the Option\'s own wording', async () => {
    const r = await first(group('Pronouns', ['He/him', 'She/her', 'They/them', 'Prefer not to say']))
    expect(r).toMatchObject({ tier: 'auto', source: 'answer_bank', key: 'pronouns', value: 'She/her' })
    expect(modelCalls()).toBe(0)
  })

  it('stored pronouns with no equal Option leave the group to Mapping, which ends Needs input when it finds nothing', async () => {
    const f = group('Pronouns', ['He/him', 'They/them', 'Prefer not to say'])
    expect(await first(f)).toBe(PENDING)
    expect(mapping).not.toHaveBeenCalled()
    // The row names the pronouns key, so an Option accepted for it is learned (ticket #35).
    expect(await mapped(f)).toMatchObject({ tier: 'needs_input', key: 'pronouns', value: null })
    expect(mapping).toHaveBeenCalledTimes(1)
  })

  it('with no equal Option, an exact Saved answer on the question still answers the group', async () => {
    save('Pronouns', 'They/them')
    const r = await first(group('Pronouns', ['He/him', 'They/them']))
    expect(r).toMatchObject({ tier: 'auto', source: 'saved_answer', key: null, value: 'They/them' })
  })

  it('a pronoun text box is still answered from the stored Value', async () => {
    expect(await first(textBox('Pronouns'))).toMatchObject({ tier: 'auto', key: 'pronouns', value: 'she/her' })
  })
})
