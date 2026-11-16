import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { yesNoCandidates, type EnumField, type FieldHandle, type Resolution, type WidgetKind } from '@jff/shared'
import type Database from 'better-sqlite3'
import { getAnswerBank, openDb, setAnswerBank, setProfile } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'

// Ticket #29: work authorization is the list of countries where the user may
// work, and authorization, sponsorship and residence questions are answered
// for the country they name. Every test goes through the host's request
// handler with a real in-memory database and a fake Mapping runner (spec #6,
// testing decision 2). The persona is Ada Lovelace; the countries are not the
// maintainer's.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string }

const PT_DE = '["de","pt"]'

let db: Database.Database
let deps: HandlerDeps
let mapping: ReturnType<typeof vi.fn>
let decide: (ref: string) => Decision
let generationPrompts: string[]

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, {
    firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100',
    location: 'Lisbon, Portugal', city: 'Lisbon', country: 'Portugal',
  })
  setAnswerBank(db, { workAuth: PT_DE })
  decide = () => ({ decision: 'custom' })
  generationPrompts = []
  mapping = vi.fn(async (prompt: string) =>
    [...prompt.matchAll(/^- ref=(\S+)/gm)].map((m) => {
      const d = decide(m[1]!)
      return { ref: m[1]!, decision: d.decision, knownKey: d.knownKey ?? null, answerId: null }
    }))
  const claude = {
    complete: vi.fn(async (prompt: string) => {
      generationPrompts.push(prompt)
      return { draft: 'A draft.' }
    }),
  }
  deps = {
    db,
    runner: claude as unknown as HandlerDeps['runner'],
    codex: { complete: mapping } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

let fid = 0
const field = (label: string, kind: WidgetKind, extra: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid: fid++, epoch: 7, label, name: null, idAttr: null, kind,
  options: kind === 'text' ? [] : ['Yes', 'No'], required: false, visible: true, currentValue: null, demographic: false, ...extra,
})

async function send<T>(method: 'resolve.first' | 'resolve.mapping', fields: EnumField[]): Promise<T> {
  const r = await handleRequest(deps, {
    requestId: crypto.randomUUID(), method,
    params: { epoch: 7, url: 'https://jobs.example.com/acme/1', hostname: 'jobs.example.com', company: 'Acme', jobText: 'Engineer wanted.', fields },
  })
  if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r)}`)
  return r.result as T
}

/** `resolve.first` for Fields it must decide without a model. */
async function first(...fields: EnumField[]): Promise<Resolution[]> {
  const r = await send<{ resolutions: Resolution[]; pending: FieldHandle[] }>('resolve.first', fields)
  return fields.map((f) => {
    const decided = r.resolutions.find((x) => x.handle.fid === f.fid)
    if (decided === undefined) throw new Error(`resolve.first left "${f.label}" pending`)
    return decided
  })
}

async function mapped(...fields: EnumField[]): Promise<Resolution[]> {
  const r = await send<{ resolutions: Resolution[] }>('resolve.mapping', fields)
  return fields.map((f) => r.resolutions.find((x) => x.handle.fid === f.fid)!)
}

const auth = (country: string, kind: WidgetKind = 'radiogroup') => field(`Are you legally authorized to work in ${country}?`, kind)
const sponsor = (country: string, kind: WidgetKind = 'radiogroup') => field(`Will you require sponsorship to work in ${country}?`, kind)

describe('work authorization, for the country the label names', () => {
  it('with Portugal and Germany: Germany auto-fills yes and the United States auto-fills no', async () => {
    const [de, us] = await first(auth('Germany'), auth('the United States'))
    expect(de).toMatchObject({ tier: 'auto', source: 'answer_bank', key: 'workAuth', value: 'Yes' })
    expect(de!.candidates).toEqual(yesNoCandidates('yes'))
    expect(us).toMatchObject({ tier: 'auto', source: 'answer_bank', key: 'workAuth', value: 'No' })
    expect(us!.candidates).toEqual(yesNoCandidates('no'))
  })

  it('"the US or Canada" is yes only when both are in the list', async () => {
    setAnswerBank(db, { workAuth: '["us"]' })
    const [one] = await first(field('Are you authorized to work in the US or Canada?', 'select'))
    expect(one).toMatchObject({ tier: 'auto', key: 'workAuth', value: 'No' })
    setAnswerBank(db, { workAuth: '["ca","us"]' })
    const [both] = await first(field('Are you authorized to work in the US or Canada?', 'select'))
    expect(both).toMatchObject({ tier: 'auto', key: 'workAuth', value: 'Yes' })
  })

  it('a question that asks for authorization without sponsorship is an authorization question', async () => {
    const [us, de] = await first(
      field('Are you legally authorized to work in the United States without sponsorship?', 'select'),
      field('Are you legally authorized to work in Germany without visa sponsorship?', 'select'))
    expect(us).toMatchObject({ tier: 'auto', key: 'workAuth', value: 'No' })
    expect(de).toMatchObject({ tier: 'auto', key: 'workAuth', value: 'Yes' })
  })

  it('a question that names no country is Proposed with the answer for my own country, and says why', async () => {
    const label = 'Are you legally authorized to work in the country where this job is located?'
    const [own] = await first(field(label, 'radiogroup'))
    expect(own).toMatchObject({ tier: 'proposed', source: 'answer_bank', key: 'workAuth', value: 'Yes', reason: 'no-country-named' })
    expect(own!.candidates).toEqual(yesNoCandidates('yes'))
    setProfile(db, { country: 'United States' })
    const [elsewhere] = await first(field(label, 'radiogroup'))
    expect(elsewhere).toMatchObject({ tier: 'proposed', key: 'workAuth', value: 'No', reason: 'no-country-named' })
  })

  it('with no country stored, a question that names none is Needs input', async () => {
    setProfile(db, { country: '' })
    const [r] = await first(field('Are you legally authorized to work in the country where this job is located?', 'radiogroup'))
    expect(r).toMatchObject({ tier: 'needs_input', key: 'workAuth', value: null })
  })

  it('a Portuguese question on a text box is answered "Sim" or "Não"', async () => {
    const [de, us] = await first(
      field('Você tem autorização para trabalhar na Alemanha?', 'text'),
      field('Você tem autorização para trabalhar nos Estados Unidos?', 'text'))
    expect(de).toMatchObject({ tier: 'auto', key: 'workAuth', value: 'Sim' })
    expect(us).toMatchObject({ tier: 'auto', key: 'workAuth', value: 'Não' })
  })
})

describe('sponsorship, the mirror of work authorization', () => {
  it('the United States needs sponsorship and Germany does not', async () => {
    const [us, de] = await first(sponsor('the United States'), sponsor('Germany'))
    expect(us).toMatchObject({ tier: 'auto', source: 'answer_bank', key: 'sponsorshipNeeded', value: 'Yes' })
    expect(us!.candidates).toEqual(yesNoCandidates('yes'))
    expect(de).toMatchObject({ tier: 'auto', key: 'sponsorshipNeeded', value: 'No' })
  })

  it('an authorization and a sponsorship question about the same country never both say yes', async () => {
    for (const country of ['Germany', 'Portugal', 'the United States', 'Canada', 'the US or Canada', 'Portugal or Germany', 'Germany or Japan']) {
      const [a, s] = await first(auth(country), sponsor(country))
      expect([a!.value, s!.value].sort(), country).toEqual(['No', 'Yes'])
    }
  })

  it('a question that names no country is Proposed with the answer for my own country', async () => {
    const [r] = await first(field('Will you now or in the future require visa sponsorship?', 'select'))
    expect(r).toMatchObject({ tier: 'proposed', key: 'sponsorshipNeeded', value: 'No', reason: 'no-country-named' })
  })
})

describe('residence, from my own country', () => {
  const FIXTURE = fileURLToPath(new URL('../../../e2e/fixtures/real/based-in-yes-no.html', import.meta.url))

  /** The based-in-yes-no real-page fixture's own question, as Enumeration reads it: yes/no buttons. */
  function fixtureQuestion(): EnumField {
    const html = readFileSync(FIXTURE, 'utf8')
    const raw = /<label[^>]*>(Are you based in[^<]*)<\/label>/.exec(html)?.[1]
    if (raw === undefined) throw new Error('the fixture lost its based-in question')
    const label = raw.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    return field(label, 'choice', { options: ['Yes', 'No'] })
  }

  it('with a stored country of Portugal, the fixture\'s "Are you based in US or Canada?" auto-fills no, and no place text is offered', async () => {
    const question = fixtureQuestion()
    expect(question.label).toMatch(/based in\s+US or Canada/)
    const [r] = await first(question)
    expect(r).toMatchObject({ tier: 'auto', source: 'profile', key: 'country', value: 'No' })
    expect(r!.candidates).toEqual(yesNoCandidates('no'))
    for (const place of ['Lisbon', 'Portugal']) {
      expect(r!.value).not.toContain(place)
      for (const c of r!.candidates ?? []) expect(c).not.toContain(place)
    }
    // Mapping never sees it either.
    const [again] = await mapped(fixtureQuestion())
    expect(again).toMatchObject({ tier: 'auto', key: 'country', value: 'No' })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('yes when my country is among the named ones, in both languages and on a text box', async () => {
    const [en, pt, text] = await first(
      field('Do you live in Spain or Portugal?', 'radiogroup'),
      field('Você mora em Portugal?', 'radiogroup'),
      field('Are you based in Portugal?', 'text'))
    expect(en).toMatchObject({ tier: 'auto', key: 'country', value: 'Yes' })
    expect(pt).toMatchObject({ tier: 'auto', key: 'country', value: 'Sim' })
    expect(text).toMatchObject({ tier: 'auto', key: 'country', value: 'Yes' })
  })

  it('with no country stored, a residence question is Needs input', async () => {
    setProfile(db, { country: '' })
    const [r] = await first(field('Do you live in the United States?', 'radiogroup'))
    expect(r).toMatchObject({ tier: 'needs_input', key: 'country', value: null })
  })

  it('a residence question that names no country is not answered by this rule', async () => {
    const [r] = await mapped(field('Are you based in London?', 'radiogroup'))
    expect(r).not.toMatchObject({ value: 'Yes' })
    expect(r).not.toMatchObject({ value: 'No' })
    expect(r!.value ?? '').not.toContain('Lisbon')
  })
})

describe('a region instead of countries', () => {
  it('"the EU" and EMEA are Needs input with the reason names-region, and keep their Known key', async () => {
    const [eu, emea, sp, live] = await first(
      field('Are you authorized to work in the EU?', 'radiogroup'),
      field('Are you legally authorized to work in EMEA?', 'select'),
      field('Will you require sponsorship to work in LATAM?', 'select'),
      field('Are you based in EMEA?', 'choice'))
    expect(eu).toMatchObject({ tier: 'needs_input', key: 'workAuth', value: null, reason: 'names-region' })
    expect(emea).toMatchObject({ tier: 'needs_input', key: 'workAuth', value: null, reason: 'names-region' })
    expect(sp).toMatchObject({ tier: 'needs_input', key: 'sponsorshipNeeded', value: null, reason: 'names-region' })
    expect(live).toMatchObject({ tier: 'needs_input', key: 'country', value: null, reason: 'names-region' })
  })
})

describe('no list stored', () => {
  it('a workAuth stored before this ticket as a bare yes has no Value: authorization and sponsorship Fields are Needs input', async () => {
    setAnswerBank(db, { workAuth: 'yes' })
    const [a, s] = await first(auth('Germany'), sponsor('Germany'))
    expect(a).toMatchObject({ tier: 'needs_input', key: 'workAuth', value: null })
    expect(a!.reason).toMatch(/no-value$/)
    expect(s).toMatchObject({ tier: 'needs_input', key: 'sponsorshipNeeded', value: null })
    expect(s!.reason).toMatch(/no-value$/)
  })

  it('with nothing stored, they are Needs input too, and so is a question that names no country', async () => {
    setAnswerBank(db, { workAuth: '' })
    const [a, s, none] = await first(auth('Germany'), sponsor('Germany'), field('Are you legally authorized to work here?', 'text'))
    for (const r of [a, s, none]) expect(r).toMatchObject({ tier: 'needs_input', value: null })
    expect(a!.reason).toMatch(/no-stored-value$/)
  })

  it('a stored sponsorship answer from before this ticket is ignored', async () => {
    setAnswerBank(db, { workAuth: '', sponsorshipNeeded: 'no' })
    const [s] = await first(sponsor('Germany'))
    expect(s).toMatchObject({ tier: 'needs_input', key: 'sponsorshipNeeded', value: null })
  })

  it('a write of sponsorshipNeeded is refused; a write of workAuth stores the canonical list', async () => {
    const refused = await handleRequest(deps, { requestId: crypto.randomUUID(), method: 'answerBank.set', params: { values: { sponsorshipNeeded: 'no' } } })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    const stored = await handleRequest(deps, { requestId: crypto.randomUUID(), method: 'answerBank.set', params: { values: { workAuth: '["pt","ca"]' } } })
    expect(stored.ok).toBe(true)
    expect(getAnswerBank(db)['workAuth']).toBe('["ca","pt"]')
  })
})

describe('a Field Mapping maps to these keys', () => {
  it('an authorization question mapped by the model, with a named country, is Proposed with the same answer', async () => {
    decide = () => ({ decision: 'known_key', knownKey: 'workAuth' })
    const de = field('Do you hold a permit for employment in Germany?', 'select')
    const us = field('Do you hold a permit for employment in the United States?', 'select')
    const r = await send<{ resolutions: Resolution[]; pending: FieldHandle[] }>('resolve.first', [de, us])
    expect(r.pending).toHaveLength(2)
    const [a, b] = await mapped(de, us)
    expect(a).toMatchObject({ tier: 'proposed', source: 'llm_key', key: 'workAuth', value: 'Yes' })
    expect(a!.candidates).toEqual(yesNoCandidates('yes'))
    expect(b).toMatchObject({ tier: 'proposed', source: 'llm_key', key: 'workAuth', value: 'No' })
  })

  it('a sponsorship question mapped by the model is Proposed with the derived answer, and a region is Needs input', async () => {
    decide = () => ({ decision: 'known_key', knownKey: 'sponsorshipNeeded' })
    const [us, region] = await mapped(
      field('Would hiring you in the United States involve an employer petition?', 'radiogroup'),
      field('Would hiring you in EMEA involve an employer petition?', 'radiogroup'))
    expect(us).toMatchObject({ tier: 'proposed', source: 'llm_key', key: 'sponsorshipNeeded', value: 'Yes' })
    expect(region).toMatchObject({ tier: 'needs_input', key: 'sponsorshipNeeded', value: null, reason: 'names-region' })
  })
})

describe('the Profile summary handed to Generation', () => {
  it('names the countries of workAuth in words', async () => {
    const r = await handleRequest(deps, {
      requestId: crypto.randomUUID(), method: 'generate',
      params: { handle: { frameId: 0, fid: 1, epoch: 7 }, questionRaw: 'Why Acme?', jobText: 'Engineer wanted.', company: 'Acme' },
    })
    expect(r.ok).toBe(true)
    expect(generationPrompts[0]).toContain('workAuth: Germany, Portugal')
    expect(generationPrompts[0]).not.toContain(PT_DE)
  })
})
