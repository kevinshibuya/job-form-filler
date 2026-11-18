import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField, FieldHandle, Resolution, WidgetKind } from '@jff/shared'
import { openDb, setAnswerBank, setProfile, upsertAnswer } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'
import { normalizeQuestion } from './normalize.js'

// Ticket #34 at the Native host seam (spec #6, testing decision 2): a Field
// whose stored Value the tool knows, but which has no rule answer to send,
// comes back Needs input carrying that identified stored Value, so the Side
// panel can read the Control's Options and ask the model pick. A Field with
// nothing identified carries none. Requests go through the host's request
// handler with a real in-memory database and a fake Mapping runner. The
// persona is Ada Lovelace; the countries are not the maintainer's.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string; answerId?: number }

let db: Database.Database
let deps: HandlerDeps
let mapping: ReturnType<typeof vi.fn>
let decide: (ref: string) => Decision

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100', country: 'Portugal' })
  setAnswerBank(db, { workAuth: '["de","pt"]', pronouns: 'she/her' })
  decide = () => ({ decision: 'custom' })
  mapping = vi.fn(async (prompt: string) =>
    [...prompt.matchAll(/^- ref=(\S+)/gm)].map((m) => {
      const d = decide(m[1]!)
      return { ref: m[1]!, decision: d.decision, knownKey: d.knownKey ?? null, answerId: d.answerId ?? null }
    }))
  deps = {
    db,
    runner: { complete: vi.fn(async () => { throw new Error('claude is not part of Resolution') }) } as unknown as HandlerDeps['runner'],
    codex: { complete: mapping } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

let fid = 0
const field = (label: string, kind: WidgetKind, options: string[] = []): EnumField => ({
  frameId: 0, fid: fid++, epoch: 3, label, name: null, idAttr: null, kind,
  options, required: false, visible: true, currentValue: null, demographic: false,
})

async function send<T>(method: 'resolve.first' | 'resolve.mapping', fields: EnumField[]): Promise<T> {
  const r = await handleRequest(deps, {
    requestId: crypto.randomUUID(), method,
    params: { epoch: 3, url: 'https://boards.greenhouse.io/acme/1', hostname: 'boards.greenhouse.io', company: 'Acme', jobText: 'Engineer.', fields },
  })
  if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r)}`)
  return r.result as T
}

/** The first step's Resolution of the Field, or 'pending'. */
async function first(f: EnumField): Promise<Resolution | 'pending'> {
  const r = await send<{ resolutions: Resolution[]; pending: FieldHandle[] }>('resolve.first', [f])
  return r.resolutions.find((x) => x.handle.fid === f.fid) ?? 'pending'
}

/** The Resolution the panel ends with: the first step's, else Mapping's. */
async function resolved(f: EnumField): Promise<Resolution> {
  const r = await first(f)
  if (r !== 'pending') return r
  return (await send<{ resolutions: Resolution[] }>('resolve.mapping', [f])).resolutions[0]!
}

function save(question: string, answer: string): number {
  return upsertAnswer(db, {
    questionNormalized: normalizeQuestion(question), questionRaw: question,
    answer, language: 'en', reusability: 'reusable',
  })
}

const PROSE = 'I have spent the last six years building data pipelines for analytical engines, and I would bring that experience to your team from day one.'
const YES_NO = ['Select...', 'Yes', 'No']

describe('a country question whose label names a region', () => {
  it('"Are you authorized to work in the EU?" carries the stored workAuth list', async () => {
    const r = await resolved(field('Are you authorized to work in the EU?', 'combobox'))
    expect(r).toMatchObject({ tier: 'needs_input', value: null, key: 'workAuth', reason: 'names-region', identifiedValue: 'Germany, Portugal' })
  })

  it('a sponsorship question naming a region carries the same list', async () => {
    const r = await resolved(field('Will you require sponsorship to work in LATAM?', 'select', YES_NO))
    expect(r).toMatchObject({ tier: 'needs_input', key: 'sponsorshipNeeded', reason: 'names-region', identifiedValue: 'Germany, Portugal' })
  })

  it('a residence question naming a region carries the stored country', async () => {
    const r = await resolved(field('Are you based in EMEA?', 'radiogroup', ['Yes', 'No']))
    expect(r).toMatchObject({ tier: 'needs_input', key: 'country', reason: 'names-region', identifiedValue: 'Portugal' })
  })

  it('the list is written in the language of the label', async () => {
    const r = await resolved(field('Você tem autorização para trabalhar na União Europeia?', 'select', ['Sim', 'Não']))
    expect(r).toMatchObject({ reason: 'names-region', identifiedValue: 'Alemanha, Portugal' })
  })

  it('with no workAuth list stored, it carries nothing', async () => {
    setAnswerBank(db, { workAuth: '' })
    const r = await resolved(field('Are you authorized to work in the EU?', 'combobox'))
    expect(r).toMatchObject({ tier: 'needs_input', reason: 'names-region' })
    expect(r.identifiedValue).toBeUndefined()
  })

  it('with only old text where the list should be, it carries nothing', async () => {
    setAnswerBank(db, { workAuth: 'yes' })
    const r = await resolved(field('Are you authorized to work in the EU?', 'combobox'))
    expect(r.identifiedValue).toBeUndefined()
  })

  it('a residence question with no country stored carries nothing', async () => {
    setProfile(db, { country: '' })
    const r = await resolved(field('Are you based in EMEA?', 'radiogroup', ['Yes', 'No']))
    expect(r.identifiedValue).toBeUndefined()
  })

  it('a question that names countries is answered by rule and carries nothing more', async () => {
    const r = await resolved(field('Are you authorized to work in Germany?', 'select', YES_NO))
    expect(r).toMatchObject({ tier: 'auto', value: 'Yes' })
    expect(r.identifiedValue).toBeUndefined()
  })
})

describe('a pronoun checkbox group', () => {
  const PRONOUNS = ['He/him', 'They/them', 'Xe/xem']

  it('that offers no Option equal to the stored pronouns carries them, whatever Mapping says', async () => {
    const r = await resolved(field('Pronouns', 'checkboxgroup', PRONOUNS))
    expect(r).toMatchObject({ tier: 'needs_input', value: null, identifiedValue: 'she/her' })
  })

  it('the same when Mapping names the pronouns key', async () => {
    decide = () => ({ decision: 'known_key', knownKey: 'pronouns' })
    const r = await resolved(field('How should we address you?', 'checkboxgroup', PRONOUNS))
    expect(r).toMatchObject({ tier: 'needs_input', value: null, identifiedValue: 'she/her' })
  })

  it('that offers the stored pronouns is filled with that Option and carries nothing more', async () => {
    const r = await resolved(field('Pronouns', 'checkboxgroup', ['He/him', 'She/her']))
    expect(r).toMatchObject({ tier: 'auto', value: 'She/her' })
    expect(r.identifiedValue).toBeUndefined()
  })

  it('with no pronouns stored, it carries nothing', async () => {
    setAnswerBank(db, { pronouns: '' })
    const r = await resolved(field('Pronouns', 'checkboxgroup', PRONOUNS))
    expect(r).toMatchObject({ tier: 'needs_input', value: null })
    expect(r.identifiedValue).toBeUndefined()
  })
})

describe('a Saved answer that equals none of the Options known at Scan', () => {
  const BEFORE = 'Have you previously worked for this company?'

  it('a paragraph for a native Yes/No select carries the paragraph, never as the Value', async () => {
    save(BEFORE, PROSE)
    const r = await resolved(field(BEFORE, 'select', YES_NO))
    expect(r).toMatchObject({ tier: 'needs_input', value: null, identifiedValue: PROSE })
  })

  it('the same on a radio group, and under a recognized key that has no Value', async () => {
    save(BEFORE, PROSE)
    expect(await resolved(field(BEFORE, 'radiogroup', ['Yes', 'No']))).toMatchObject({ value: null, identifiedValue: PROSE })
    const RELOCATE = 'Are you willing to relocate for this role?'
    save(RELOCATE, PROSE)
    expect(await resolved(field(RELOCATE, 'select', YES_NO))).toMatchObject({ value: null, identifiedValue: PROSE })
  })

  it('a Saved answer Mapping reuses carries its text the same way', async () => {
    const id = save('Were you ever employed here?', PROSE)
    decide = () => ({ decision: 'reuse_answer', answerId: id })
    const r = await resolved(field('Former employee?', 'select', YES_NO))
    expect(r).toMatchObject({ tier: 'needs_input', value: null, identifiedValue: PROSE })
  })

  it('a Saved answer equal to one Option fills it and carries nothing more', async () => {
    save(BEFORE, 'no')
    const r = await resolved(field(BEFORE, 'select', YES_NO))
    expect(r).toMatchObject({ tier: 'auto', value: 'No' })
    expect(r.identifiedValue).toBeUndefined()
  })
})

describe('a Field with nothing identified', () => {
  it('a question Mapping matched to nothing carries nothing', async () => {
    const r = await resolved(field('How did you hear about us?', 'select', ['LinkedIn', 'A friend']))
    expect(r).toMatchObject({ tier: 'needs_input', value: null })
    expect(r.identifiedValue).toBeUndefined()
  })

  it('a recognized key with no stored Value and no Saved answer carries nothing', async () => {
    const r = await resolved(field('Are you willing to relocate?', 'select', YES_NO))
    expect(r).toMatchObject({ tier: 'needs_input', value: null })
    expect(r.identifiedValue).toBeUndefined()
  })

  it('a Mapping that failed carries nothing on an unrecognized Field', async () => {
    mapping.mockImplementation(async () => { throw new Error('boom') })
    const r = await resolved(field('Why Acme?', 'textarea'))
    expect(r).toMatchObject({ tier: 'needs_input' })
    expect(r.identifiedValue).toBeUndefined()
  })
})
