import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField, Resolution } from '@jff/shared'
import { openDb, setProfile, setAnswerBank, upsertAnswer, getAnswerById } from '../db/repos.js'
import { resolveFirst, resolveMapping } from './waterfall.js'
import { CodexError, type CodexRunner } from '../llm/codexCli.js'
import type { MappingDecision } from '../llm/mapping.js'
import { normalizeQuestion } from './normalize.js'

const OPTS = { model: 'gpt-5.6-sol' }

const field = (fid: number, label: string, extra: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid, epoch: 5, label, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...extra,
})

const input = (fields: EnumField[]) => ({
  epoch: 5, url: 'https://boards.greenhouse.io/acme/jobs/1',
  hostname: 'boards.greenhouse.io', company: 'Acme', jobText: 'Senior engineer wanted.', fields,
})

/**
 * CodexRunner stubs whose mapping decisions are dictated by the test.
 * `complete` is GENERIC on CodexRunner and a plain `vi.fn` is not assignable to a
 * generic signature, so the stubs are cast once here and keep the `Mock` type for
 * call assertions. Do NOT "fix" this by making CodexRunner non-generic.
 */
type StubRunner = CodexRunner & { complete: Mock }

const runnerReturning = (decisions: Record<string, MappingDecision>): StubRunner => ({
  complete: vi.fn(async () =>
    Object.entries(decisions).map(([ref, d]) => ({ ref, decision: d.decision, knownKey: d.knownKey, answerId: d.answerId })),
  ),
} as unknown as StubRunner)

const runnerThatThrows = (kind: 'rate_limit'): StubRunner => ({
  complete: vi.fn(async () => { throw new CodexError(kind, 'limit') }),
} as unknown as StubRunner)

let db: Database.Database

/** A Field the first step leaves for Mapping. */
const PENDING = 'pending' as const

/** The first step (`resolve.first`): each Field's Resolution, or PENDING, in Field order. */
function first(fields: EnumField[]): (Resolution | typeof PENDING)[] {
  const r = resolveFirst(db, input(fields))
  return fields.map((f) => {
    const decided = r.resolutions.find((x) => x.handle.fid === f.fid)
    if (decided !== undefined) return decided
    if (r.pending.some((h) => h.fid === f.fid)) return PENDING
    throw new Error(`the first step neither decided nor left pending fid ${f.fid}`)
  })
}

/** The Mapping step (`resolve.mapping`) over the given Fields. */
const mapped = (codex: CodexRunner, fields: EnumField[]) => resolveMapping({ db, codex, mappingOpts: OPTS }, input(fields))

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { firstName: 'Ada', email: 'ada@example.com' })
  setAnswerBank(db, { salary: '{"amount":18000,"currency":"BRL","period":"month"}' })
})

describe('tier 0 — EEO', () => {
  it('skips a demographic field and never gives it a value', () => {
    const [r] = first([field(1, 'Gender', { demographic: true })])
    expect(r).toMatchObject({ tier: 'skipped', value: null, source: null, reason: 'eeo' })
  })

  it('never sends a demographic field to the LLM, even when the Mapping step is sent it', async () => {
    const runner = runnerReturning({})
    const r = await mapped(runner, [field(1, 'Gender', { demographic: true })])
    expect(r.resolutions[0]).toMatchObject({ tier: 'skipped', value: null, reason: 'eeo' })
    expect(runner.complete).not.toHaveBeenCalled()
  })
})

describe('tier 1 — values already on the page', () => {
  it('treats an ATS-populated value as filled, sourced from the page', () => {
    const [r] = first([field(1, 'First Name', { currentValue: 'Ada' })])
    expect(r).toMatchObject({ tier: 'auto', source: 'page', value: 'Ada', reason: 'already-on-page' })
  })
})

describe('tier 2 — deterministic recognizers', () => {
  it('auto-fills a recognized key that has a stored value', () => {
    const [r] = first([field(1, 'E-mail *')])
    expect(r).toMatchObject({ tier: 'auto', source: 'profile', key: 'email', value: 'ada@example.com', reason: 'recognizer:email' })
  })

  it('routes a recognized key with NO stored value to needs-input', () => {
    const [r] = first([field(1, 'GitHub URL')])
    expect(r).toMatchObject({ tier: 'needs_input', value: null, reason: 'recognizer:github:no-stored-value' })
  })

  it('reads an answer-bank key from the answer bank, not the profile', () => {
    // A salary is always Proposed (ticket #33), even from a recognizer.
    const [r] = first([field(1, 'Desired salary')])
    expect(r).toMatchObject({ tier: 'proposed', source: 'answer_bank', key: 'salary', value: '18000 BRL per month' })
  })
})

describe('tier 3 — exact saved answers and the company-specificity guard', () => {
  it('auto-fills an exact reusable match and bumps times_used', () => {
    const id = upsertAnswer(db, {
      questionNormalized: 'how many years of react do you have', questionRaw: 'How many years of React do you have?',
      answer: '6 years', language: 'en', reusability: 'reusable',
    })
    const [r] = first([field(1, 'How many years of React do you have?')])
    expect(r).toMatchObject({ tier: 'auto', source: 'saved_answer', value: '6 years', answerId: id, reason: 'exact-match' })
    expect(getAnswerById(db, id)!.timesUsed).toBe(1)
  })

  it('never auto-fills a company_specific exact match — it falls through to needs-input', async () => {
    upsertAnswer(db, {
      questionNormalized: 'why do you want to work here', questionRaw: 'Why do you want to work here?',
      answer: 'Because I love Acme', language: 'en', reusability: 'company_specific',
    })
    const why = field(1, 'Why do you want to work here?')
    expect(first([why])).toEqual([PENDING])
    const r = await mapped(runnerReturning({ '0:1': { decision: 'custom', knownKey: null, answerId: null } }), [why])
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', value: null, reason: 'custom' })
  })

  it('does not offer company_specific rows to the mapping call as candidates', async () => {
    upsertAnswer(db, { questionNormalized: 'why acme', questionRaw: 'Why Acme?', answer: 'secret', language: 'en', reusability: 'company_specific' })
    upsertAnswer(db, { questionNormalized: 'years of react', questionRaw: 'Years of React?', answer: '6', language: 'en', reusability: 'reusable' })
    const runner = runnerReturning({ '0:1': { decision: 'custom', knownKey: null, answerId: null } })
    await mapped(runner, [field(1, 'Describe a hard bug you fixed.')])
    const prompt = runner.complete.mock.calls[0]![0] as string
    expect(prompt).toContain('Years of React?')
    expect(prompt).not.toContain('Why Acme?')
    expect(prompt).not.toContain('secret')
  })
})

describe('tier 4 — LLM results are PROPOSED, never auto', () => {
  it('proposes a value for an LLM known_key with a stored value', async () => {
    const r = await mapped(
      runnerReturning({ '0:1': { decision: 'known_key', knownKey: 'salary', answerId: null } }),
      [field(1, 'What are your comp expectations for this role?')],
    )
    expect(r.resolutions[0]).toMatchObject({ tier: 'proposed', source: 'llm_key', key: 'salary', value: '18000 BRL per month' })
  })

  it('substitutes the DB value, never anything the model said', async () => {
    const runner = { complete: vi.fn(async () => [{ ref: '0:1', decision: 'known_key', knownKey: 'salary', answerId: null, value: 'R$ 999.999' }]) } as unknown as StubRunner
    const r = await mapped(runner, [field(1, 'Comp expectations?')])
    expect(r.resolutions[0]!.value).toBe('18000 BRL per month')
  })

  it('routes an LLM known_key with no stored value to needs-input', async () => {
    const r = await mapped(
      runnerReturning({ '0:1': { decision: 'known_key', knownKey: 'notice', answerId: null } }),
      [field(1, 'How soon could you join?')],
    )
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', reason: 'llm-key:notice:no-stored-value' })
  })

  it('proposes a reused reusable answer', async () => {
    const id = upsertAnswer(db, { questionNormalized: 'years of react', questionRaw: 'Years of React?', answer: '6 years', language: 'en', reusability: 'reusable' })
    const r = await mapped(
      runnerReturning({ '0:1': { decision: 'reuse_answer', knownKey: null, answerId: id } }),
      [field(1, 'React experience in years?')],
    )
    expect(r.resolutions[0]).toMatchObject({ tier: 'proposed', source: 'llm_reuse', value: '6 years', answerId: id })
  })

  it('refuses to reuse a company_specific answer even when the model points at it', async () => {
    const id = upsertAnswer(db, { questionNormalized: 'why acme', questionRaw: 'Why Acme?', answer: 'secret', language: 'en', reusability: 'company_specific' })
    const r = await mapped(
      runnerReturning({ '0:1': { decision: 'reuse_answer', knownKey: null, answerId: id } }),
      [field(1, 'Why do you want to join Acme?')],
    )
    // The refusal happens one layer UP, in validateMappingResponse: company_specific rows are
    // never offered as candidates, so this answerId is out-of-set and degrades to `custom`
    // before the Mapping step sees it. The Mapping step's own company-specificity check stays as
    // defense-in-depth (unreachable via this path by construction, which is the point).
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', value: null, reason: 'custom' })
  })
})

describe('tier 5 and failure modes', () => {
  it('resolves an LLM custom decision to needs-input with reason custom', async () => {
    const r = await mapped(
      runnerReturning({ '0:1': { decision: 'custom', knownKey: null, answerId: null } }),
      [field(1, 'Tell us about a hard technical decision.')],
    )
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', reason: 'custom', value: null })
  })

  it('fails every unresolved field closed when the mapping response does not round-trip', async () => {
    // Both labels must miss every baseline recognizer, or the field resolves at tier 2 and
    // never enters the LLM batch this test is exercising.
    const fields = [field(1, 'Anything else?'), field(2, 'What should we know about you?')]
    expect(first(fields)).toEqual([PENDING, PENDING])
    const r = await mapped(runnerReturning({ '9:9': { decision: 'custom', knownKey: null, answerId: null } }), fields)
    expect(r.resolutions.every((x) => x.tier === 'needs_input')).toBe(true)
    expect(r.resolutions.every((x) => x.reason === 'llm-unavailable')).toBe(true)
  })

  it('reports a rate limit without throwing and leaves fields as needs-input', async () => {
    const r = await mapped(runnerThatThrows('rate_limit'), [field(1, 'Anything else?')])
    expect(r.llmError).toEqual({ kind: 'rate_limit', message: 'limit' })
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', reason: 'llm-error:rate_limit' })
  })

  it('does not call the LLM at all when every field resolved deterministically', async () => {
    const fields = [field(1, 'E-mail'), field(2, 'First Name')]
    expect(resolveFirst(db, input(fields)).pending).toEqual([])
    const runner = runnerReturning({})
    await mapped(runner, fields)
    expect(runner.complete).not.toHaveBeenCalled()
  })

  it('echoes the request epoch on both steps so the panel can reject a stale reply', async () => {
    expect(resolveFirst(db, input([field(1, 'E-mail')])).epoch).toBe(5)
    const r = await mapped(runnerReturning({}), [field(1, 'E-mail')])
    expect(r.epoch).toBe(5)
  })
})

describe('B5a/B5c — recall correctness', () => {
  it('tier 1 attaches the recognized key to an already-on-page value', () => {
    const [r] = first([field(1, 'First Name', { currentValue: 'Ada' })])
    expect(r).toMatchObject({
      tier: 'auto', source: 'page', value: 'Ada', key: 'firstName', reason: 'already-on-page',
    })
  })

  it('tier 1 with an unrecognizable label keeps key null', () => {
    const [r] = first([field(1, 'Tell us anything', { currentValue: 'prefilled' })])
    expect(r).toMatchObject({ tier: 'auto', source: 'page', key: null })
  })

  it('a recognized key with NO stored value falls through to the exact qa_memory match', () => {
    const id = upsertAnswer(db, {
      questionNormalized: normalizeQuestion('GitHub URL'), questionRaw: 'GitHub URL',
      answer: 'https://github.com/ada', language: 'en', reusability: 'reusable',
    })
    const [r] = first([field(1, 'GitHub URL')])
    expect(r).toMatchObject({
      tier: 'auto', source: 'saved_answer', key: 'github', answerId: id,
      value: 'https://github.com/ada', reason: 'exact-match:key-fallback',
    })
    expect(getAnswerById(db, id)!.timesUsed).toBe(1)
  })

  it('the key fallback ignores company_specific rows and lands on needs_input', () => {
    upsertAnswer(db, {
      questionNormalized: normalizeQuestion('GitHub URL'), questionRaw: 'GitHub URL',
      answer: 'secret', language: 'en', reusability: 'company_specific',
    })
    const [r] = first([field(1, 'GitHub URL')])
    expect(r).toMatchObject({ tier: 'needs_input', reason: 'recognizer:github:no-stored-value' })
  })

  it('the llm-key fallback also refuses a company_specific exact match', async () => {
    // The company_specific row gets the field PAST tier 3 (its reusability
    // check fails there) into the LLM batch; the llm-key fallback then runs
    // the same exact lookup and must refuse it too — this exercises the NEW
    // fallback path, unlike a bare no-row duplicate of the existing
    // 'routes an LLM known_key with no stored value to needs-input' test.
    upsertAnswer(db, {
      questionNormalized: normalizeQuestion('How soon could you join?'), questionRaw: 'How soon could you join?',
      answer: 'two weeks, but only for Acme', language: 'en', reusability: 'company_specific',
    })
    const join = field(1, 'How soon could you join?')
    expect(first([join])).toEqual([PENDING])
    const r = await mapped(runnerReturning({ '0:1': { decision: 'known_key', knownKey: 'notice', answerId: null } }), [join])
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', key: 'notice', reason: 'llm-key:notice:no-stored-value' })
  })
})
