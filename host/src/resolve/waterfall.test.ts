import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField } from '@jff/shared'
import { openDb, setProfile, setAnswerBank, upsertAnswer, getAnswerById } from '../db/repos.js'
import { resolveFields } from './waterfall.js'
import { ClaudeError, type ClaudeRunner } from '../llm/claudeCli.js'
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
 * ClaudeRunner stubs whose mapping decisions are dictated by the test.
 * `complete` is GENERIC on ClaudeRunner and a plain `vi.fn` is not assignable to a
 * generic signature, so the stubs are cast once here and keep the `Mock` type for
 * call assertions. Do NOT "fix" this by making ClaudeRunner non-generic.
 */
type StubRunner = ClaudeRunner & { complete: Mock }

const runnerReturning = (decisions: Record<string, MappingDecision>): StubRunner => ({
  complete: vi.fn(async () =>
    Object.entries(decisions).map(([ref, d]) => ({ ref, decision: d.decision, knownKey: d.knownKey, answerId: d.answerId })),
  ),
} as unknown as StubRunner)

const runnerThatThrows = (kind: 'rate_limit'): StubRunner => ({
  complete: vi.fn(async () => { throw new ClaudeError(kind, 'limit') }),
} as unknown as StubRunner)

let db: Database.Database
beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { firstName: 'Kevin', email: 'kevin@example.com' })
  setAnswerBank(db, { salary: 'R$ 18.000/mo' })
})

describe('tier 0 — EEO', () => {
  it('skips a demographic field and never gives it a value', async () => {
    const r = await resolveFields({ db, runner: runnerReturning({}) }, input([field(1, 'Gender', { demographic: true })]))
    expect(r.resolutions[0]).toMatchObject({ tier: 'skipped', value: null, source: null, reason: 'eeo' })
  })

  it('never sends a demographic field to the LLM', async () => {
    const runner = runnerReturning({})
    await resolveFields({ db, runner, mappingOpts: OPTS }, input([field(1, 'Gender', { demographic: true })]))
    expect(runner.complete).not.toHaveBeenCalled()
  })
})

describe('tier 1 — values already on the page', () => {
  it('treats an ATS-populated value as filled, sourced from the page', async () => {
    const r = await resolveFields({ db, runner: runnerReturning({}) },
      input([field(1, 'First Name', { currentValue: 'Kevin' })]))
    expect(r.resolutions[0]).toMatchObject({ tier: 'auto', source: 'page', value: 'Kevin', reason: 'already-on-page' })
  })
})

describe('tier 2 — deterministic recognizers', () => {
  it('auto-fills a recognized key that has a stored value', async () => {
    const r = await resolveFields({ db, runner: runnerReturning({}) }, input([field(1, 'E-mail *')]))
    expect(r.resolutions[0]).toMatchObject({ tier: 'auto', source: 'profile', key: 'email', value: 'kevin@example.com', reason: 'recognizer:email' })
  })

  it('routes a recognized key with NO stored value to needs-input', async () => {
    const r = await resolveFields({ db, runner: runnerReturning({}) }, input([field(1, 'GitHub URL')]))
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', value: null, reason: 'recognizer:github:no-stored-value' })
  })

  it('reads an answer-bank key from the answer bank, not the profile', async () => {
    const r = await resolveFields({ db, runner: runnerReturning({}) }, input([field(1, 'Desired salary')]))
    expect(r.resolutions[0]).toMatchObject({ tier: 'auto', source: 'answer_bank', key: 'salary', value: 'R$ 18.000/mo' })
  })
})

describe('tier 3 — exact saved answers and the company-specificity guard', () => {
  it('auto-fills an exact reusable match and bumps times_used', async () => {
    const id = upsertAnswer(db, {
      questionNormalized: 'how many years of react do you have', questionRaw: 'How many years of React do you have?',
      answer: '6 years', language: 'en', reusability: 'reusable',
    })
    const r = await resolveFields({ db, runner: runnerReturning({}) },
      input([field(1, 'How many years of React do you have?')]))
    expect(r.resolutions[0]).toMatchObject({ tier: 'auto', source: 'saved_answer', value: '6 years', answerId: id, reason: 'exact-match' })
    expect(getAnswerById(db, id)!.timesUsed).toBe(1)
  })

  it('never auto-fills a company_specific exact match — it falls through to needs-input', async () => {
    upsertAnswer(db, {
      questionNormalized: 'why do you want to work here', questionRaw: 'Why do you want to work here?',
      answer: 'Because I love Figma', language: 'en', reusability: 'company_specific',
    })
    const r = await resolveFields({ db, runner: runnerReturning({ '0:1': { decision: 'custom', knownKey: null, answerId: null } }) },
      input([field(1, 'Why do you want to work here?')]))
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', value: null, reason: 'custom' })
  })

  it('does not offer company_specific rows to the mapping call as candidates', async () => {
    upsertAnswer(db, { questionNormalized: 'why figma', questionRaw: 'Why Figma?', answer: 'secret', language: 'en', reusability: 'company_specific' })
    upsertAnswer(db, { questionNormalized: 'years of react', questionRaw: 'Years of React?', answer: '6', language: 'en', reusability: 'reusable' })
    const runner = runnerReturning({ '0:1': { decision: 'custom', knownKey: null, answerId: null } })
    await resolveFields({ db, runner, mappingOpts: OPTS }, input([field(1, 'Describe a hard bug you fixed.')]))
    const prompt = runner.complete.mock.calls[0]![0] as string
    expect(prompt).toContain('Years of React?')
    expect(prompt).not.toContain('Why Figma?')
    expect(prompt).not.toContain('secret')
  })
})

describe('tier 4 — LLM results are PROPOSED, never auto', () => {
  it('proposes a value for an LLM known_key with a stored value', async () => {
    const r = await resolveFields(
      { db, runner: runnerReturning({ '0:1': { decision: 'known_key', knownKey: 'salary', answerId: null } }) },
      input([field(1, 'What are your comp expectations for this role?')]),
    )
    expect(r.resolutions[0]).toMatchObject({ tier: 'proposed', source: 'llm_key', key: 'salary', value: 'R$ 18.000/mo' })
  })

  it('substitutes the DB value, never anything the model said', async () => {
    const runner = { complete: vi.fn(async () => [{ ref: '0:1', decision: 'known_key', knownKey: 'salary', answerId: null, value: 'R$ 999.999' }]) } as unknown as StubRunner
    const r = await resolveFields({ db, runner, mappingOpts: OPTS }, input([field(1, 'Comp expectations?')]))
    expect(r.resolutions[0]!.value).toBe('R$ 18.000/mo')
  })

  it('routes an LLM known_key with no stored value to needs-input', async () => {
    const r = await resolveFields(
      { db, runner: runnerReturning({ '0:1': { decision: 'known_key', knownKey: 'notice', answerId: null } }) },
      input([field(1, 'How soon could you join?')]),
    )
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', reason: 'llm-key:notice:no-stored-value' })
  })

  it('proposes a reused reusable answer', async () => {
    const id = upsertAnswer(db, { questionNormalized: 'years of react', questionRaw: 'Years of React?', answer: '6 years', language: 'en', reusability: 'reusable' })
    const r = await resolveFields(
      { db, runner: runnerReturning({ '0:1': { decision: 'reuse_answer', knownKey: null, answerId: id } }) },
      input([field(1, 'React experience in years?')]),
    )
    expect(r.resolutions[0]).toMatchObject({ tier: 'proposed', source: 'llm_reuse', value: '6 years', answerId: id })
  })

  it('refuses to reuse a company_specific answer even when the model points at it', async () => {
    const id = upsertAnswer(db, { questionNormalized: 'why figma', questionRaw: 'Why Figma?', answer: 'secret', language: 'en', reusability: 'company_specific' })
    const r = await resolveFields(
      { db, runner: runnerReturning({ '0:1': { decision: 'reuse_answer', knownKey: null, answerId: id } }) },
      input([field(1, 'Why do you want to join Acme?')]),
    )
    // The refusal happens one layer UP, in validateMappingResponse: company_specific rows are
    // never offered as candidates, so this answerId is out-of-set and degrades to `custom`
    // before the waterfall sees it. The waterfall's own company-specificity check stays as
    // defense-in-depth (unreachable via this path by construction, which is the point).
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', value: null, reason: 'custom' })
  })
})

describe('tier 5 and failure modes', () => {
  it('resolves an LLM custom decision to needs-input with reason custom', async () => {
    const r = await resolveFields(
      { db, runner: runnerReturning({ '0:1': { decision: 'custom', knownKey: null, answerId: null } }) },
      input([field(1, 'Tell us about a hard technical decision.')]),
    )
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', reason: 'custom', value: null })
  })

  it('fails every unresolved field closed when the mapping response does not round-trip', async () => {
    const r = await resolveFields(
      { db, runner: runnerReturning({ '9:9': { decision: 'custom', knownKey: null, answerId: null } }) },
      // Both labels must miss every baseline recognizer, or the field resolves at tier 2 and
      // never enters the LLM batch this test is exercising.
      input([field(1, 'Anything else?'), field(2, 'What should we know about you?')]),
    )
    expect(r.resolutions.every((x) => x.tier === 'needs_input')).toBe(true)
    expect(r.resolutions.every((x) => x.reason === 'llm-unavailable')).toBe(true)
  })

  it('reports a rate limit without throwing and leaves fields as needs-input', async () => {
    const r = await resolveFields({ db, runner: runnerThatThrows('rate_limit') }, input([field(1, 'Anything else?')]))
    expect(r.llmError).toEqual({ kind: 'rate_limit', message: 'limit' })
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', reason: 'llm-error:rate_limit' })
  })

  it('does not call the LLM at all when every field resolved deterministically', async () => {
    const runner = runnerReturning({})
    await resolveFields({ db, runner, mappingOpts: OPTS }, input([field(1, 'E-mail'), field(2, 'First Name')]))
    expect(runner.complete).not.toHaveBeenCalled()
  })

  it('echoes the request epoch so the panel can reject a stale reply', async () => {
    const r = await resolveFields({ db, runner: runnerReturning({}) }, input([field(1, 'E-mail')]))
    expect(r.epoch).toBe(5)
  })
})

describe('B5a/B5c — recall correctness', () => {
  it('tier 1 attaches the recognized key to an already-on-page value', async () => {
    const r = await resolveFields({ db, runner: runnerReturning({}) },
      input([field(1, 'First Name', { currentValue: 'Kevin' })]))
    expect(r.resolutions[0]).toMatchObject({
      tier: 'auto', source: 'page', value: 'Kevin', key: 'firstName', reason: 'already-on-page',
    })
  })

  it('tier 1 with an unrecognizable label keeps key null', async () => {
    const r = await resolveFields({ db, runner: runnerReturning({}) },
      input([field(1, 'Tell us anything', { currentValue: 'prefilled' })]))
    expect(r.resolutions[0]).toMatchObject({ tier: 'auto', source: 'page', key: null })
  })

  it('a recognized key with NO stored value falls through to the exact qa_memory match', async () => {
    const id = upsertAnswer(db, {
      questionNormalized: normalizeQuestion('GitHub URL'), questionRaw: 'GitHub URL',
      answer: 'https://github.com/kevin', language: 'en', reusability: 'reusable',
    })
    const r = await resolveFields({ db, runner: runnerReturning({}) }, input([field(1, 'GitHub URL')]))
    expect(r.resolutions[0]).toMatchObject({
      tier: 'auto', source: 'saved_answer', key: 'github', answerId: id,
      value: 'https://github.com/kevin', reason: 'exact-match:key-fallback',
    })
    expect(getAnswerById(db, id)!.timesUsed).toBe(1)
  })

  it('the key fallback ignores company_specific rows and lands on needs_input', async () => {
    upsertAnswer(db, {
      questionNormalized: normalizeQuestion('GitHub URL'), questionRaw: 'GitHub URL',
      answer: 'secret', language: 'en', reusability: 'company_specific',
    })
    const r = await resolveFields({ db, runner: runnerReturning({}) }, input([field(1, 'GitHub URL')]))
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', reason: 'recognizer:github:no-stored-value' })
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
    const r = await resolveFields(
      { db, runner: runnerReturning({ '0:1': { decision: 'known_key', knownKey: 'notice', answerId: null } }) },
      input([field(1, 'How soon could you join?')]),
    )
    expect(r.resolutions[0]).toMatchObject({ tier: 'needs_input', key: 'notice', reason: 'llm-key:notice:no-stored-value' })
  })
})
