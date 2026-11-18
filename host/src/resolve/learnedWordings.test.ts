import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField, FieldHandle, Resolution, WidgetKind } from '@jff/shared'
import { openDb, setAnswerBank, setProfile, upsertAnswer } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'
import { normalizeQuestion } from './normalize.js'
import { learnedValueOf, learnedWordingsFor } from './learnedWordings.js'

// Ticket #35 at the Native host seam (spec #6, testing decision 2): an Option
// the user accepted for a Field answered from a Known key is stored as a
// Learned wording with the key and the Value it stood for, and joins the
// candidate words of later Resolutions of that key while the Value is the one
// it was learned for. Requests go through the host's request handler with a
// real in-memory database and a fake Mapping runner that must never be asked
// for a pick. The persona is Ada Lovelace; the countries are not the
// maintainer's.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string; answerId?: number }

let db: Database.Database
let deps: HandlerDeps
let codex: ReturnType<typeof vi.fn>
let decide: (ref: string) => Decision

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100', country: 'France' })
  setAnswerBank(db, { relocate: 'yes', workAuth: '["de","fr"]', pronouns: 'she/her' })
  decide = () => ({ decision: 'custom' })
  codex = vi.fn(async (prompt: string) => {
    if (/You match a stored answer to one of the options/.test(prompt)) throw new Error('no model pick is part of Resolution')
    return [...prompt.matchAll(/^- ref=(\S+)/gm)].map((m) => {
      const d = decide(m[1]!)
      return { ref: m[1]!, decision: d.decision, knownKey: d.knownKey ?? null, answerId: d.answerId ?? null }
    })
  })
  deps = {
    db,
    runner: { complete: vi.fn(async () => { throw new Error('claude is not part of Resolution') }) } as unknown as HandlerDeps['runner'],
    codex: { complete: codex } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

let fid = 0
const field = (label: string, kind: WidgetKind, options: string[] = []): EnumField => ({
  frameId: 0, fid: fid++, epoch: 5, label, name: null, idAttr: null, kind,
  options, required: false, visible: true, currentValue: null, demographic: false,
})

async function send<T>(method: 'resolve.first' | 'resolve.mapping', fields: EnumField[]): Promise<T> {
  const r = await handleRequest(deps, {
    requestId: crypto.randomUUID(), method,
    params: { epoch: 5, url: 'https://boards.greenhouse.io/acme/1', hostname: 'boards.greenhouse.io', company: 'Acme', jobText: 'Engineer.', fields },
  })
  if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r)}`)
  return r.result as T
}

/** The Resolution the panel ends with: the first step's, else Mapping's. */
async function resolved(f: EnumField): Promise<Resolution> {
  const r = await send<{ resolutions: Resolution[]; pending: FieldHandle[] }>('resolve.first', [f])
  const decided = r.resolutions.find((x) => x.handle.fid === f.fid)
  if (decided !== undefined) return decided
  return (await send<{ resolutions: Resolution[] }>('resolve.mapping', [f])).resolutions[0]!
}

/** What the panel sends once the user accepted an Option. */
async function learn(key: string, value: string, wording: string): Promise<unknown> {
  const r = await handleRequest(deps, { requestId: crypto.randomUUID(), method: 'wording.learn', params: { key, value, wording } } as never)
  if (!r.ok) throw new Error(`wording.learn failed: ${JSON.stringify(r)}`)
  return r.result
}

const RELOCATE = 'Are you open to relocation?'
const RELOCATE_OPTIONS = ['Select...', 'Yes, I am open to relocating', 'No, I prefer to stay where I am']
const OPEN = 'Yes, I am open to relocating'

describe('a relocation dropdown whose Options say yes in their own words', () => {
  it('before anything is learned, carries only the rule table\'s words', async () => {
    const r = await resolved(field(RELOCATE, 'select', RELOCATE_OPTIONS))
    expect(r).toMatchObject({ tier: 'auto', key: 'relocate', value: 'Yes' })
    expect(r.candidates).not.toContain(OPEN)
  })

  it('once the accepted Option is learned for the yes, the next Resolution carries it among its candidate words, with no model call', async () => {
    expect(await learn('relocate', 'Yes', OPEN)).toEqual({ learned: true })
    const r = await resolved(field(RELOCATE, 'select', RELOCATE_OPTIONS))
    expect(r).toMatchObject({ tier: 'auto', key: 'relocate', value: 'Yes' })
    expect(r.candidates).toContain(OPEN)
    expect(r.candidates).toContain('Yes')
    expect(codex).not.toHaveBeenCalled()
  })

  it('a wording learned on a Portuguese form for "Sim" is a candidate for the yes on an English one', async () => {
    await learn('relocate', 'Sim', OPEN)
    const r = await resolved(field(RELOCATE, 'select', RELOCATE_OPTIONS))
    expect(r.candidates).toContain(OPEN)
  })

  it('after the stored Value changes to no, the wording is no longer a candidate', async () => {
    await learn('relocate', 'Yes', OPEN)
    setAnswerBank(db, { relocate: 'no' })
    const r = await resolved(field(RELOCATE, 'select', RELOCATE_OPTIONS))
    expect(r).toMatchObject({ key: 'relocate', value: 'No' })
    expect(r.candidates).not.toContain(OPEN)
  })

  it('and applies again once the Value is back to the one it was learned for', async () => {
    await learn('relocate', 'Yes', OPEN)
    setAnswerBank(db, { relocate: 'no' })
    setAnswerBank(db, { relocate: 'yes' })
    const r = await resolved(field(RELOCATE, 'select', RELOCATE_OPTIONS))
    expect(r.candidates).toContain(OPEN)
  })

  it('learning the same wording twice keeps one candidate', async () => {
    await learn('relocate', 'Yes', OPEN)
    await learn('relocate', 'Yes', `  ${OPEN} `)
    const r = await resolved(field(RELOCATE, 'select', RELOCATE_OPTIONS))
    expect(r.candidates!.filter((c) => c.trim() === OPEN)).toHaveLength(1)
  })
})

describe('a country dropdown', () => {
  const COUNTRY = 'Country of residence'

  it('carries a wording learned for the stored country, and stops once the country changes', async () => {
    await learn('country', 'France', 'French Republic')
    const r = await resolved(field(COUNTRY, 'combobox'))
    expect(r).toMatchObject({ key: 'country', value: 'France' })
    expect(r.candidates).toContain('French Republic')
    setProfile(db, { country: 'Spain' })
    const after = await resolved(field(COUNTRY, 'combobox'))
    expect(after).toMatchObject({ key: 'country', value: 'Spain' })
    expect(after.candidates).not.toContain('French Republic')
  })
})

describe('work authorization, a derived answer', () => {
  const auth = (country: string): EnumField =>
    field(`Are you legally authorized to work in ${country}?`, 'select', ['Select...', 'Yes, I hold the right to work', 'No, I would need a permit'])

  it('a wording learned for a yes is a candidate where the answer is yes and not where it is no', async () => {
    await learn('workAuth', 'Yes', 'Yes, I hold the right to work')
    const germany = await resolved(auth('Germany'))
    expect(germany).toMatchObject({ key: 'workAuth', value: 'Yes' })
    expect(germany.candidates).toContain('Yes, I hold the right to work')
    const us = await resolved(auth('the United States'))
    expect(us).toMatchObject({ key: 'workAuth', value: 'No' })
    expect(us.candidates).not.toContain('Yes, I hold the right to work')
  })

  it('a wording is learned only for the yes or no the Resolution gave, never for the stored list', async () => {
    expect(await learn('workAuth', 'Germany, France', 'Yes, I hold the right to work')).toEqual({ learned: false })
    const germany = await resolved(auth('Germany'))
    expect(germany.candidates).not.toContain('Yes, I hold the right to work')
  })

  it('a wording learned for work authorization is not a candidate for sponsorship', async () => {
    await learn('workAuth', 'No', 'No, I would need a permit')
    const r = await resolved(field('Will you now or in the future require visa sponsorship to work in the United States?', 'select', ['Select...', 'Yes', 'No, I would need a permit']))
    expect(r).toMatchObject({ key: 'sponsorshipNeeded' })
    expect(r.candidates).not.toContain('No, I would need a permit')
  })
})

describe('a pronoun checkbox group', () => {
  const PRONOUNS = ['He/him', 'She / her (elle)', 'They/them']

  it('that offers no Option equal to the stored pronouns carries the pronouns key with them, so an accepted pick can be learned', async () => {
    const r = await resolved(field('Pronouns', 'checkboxgroup', PRONOUNS))
    expect(r).toMatchObject({ tier: 'needs_input', value: null, key: 'pronouns', identifiedValue: 'she/her' })
  })

  it('the same when Mapping names the pronouns key', async () => {
    decide = () => ({ decision: 'known_key', knownKey: 'pronouns' })
    const r = await resolved(field('How should we address you?', 'checkboxgroup', PRONOUNS))
    expect(r).toMatchObject({ tier: 'needs_input', value: null, key: 'pronouns', identifiedValue: 'she/her' })
  })

  it('auto-fills with the learned Option on the next Scan, with no model call', async () => {
    await learn('pronouns', 'she/her', 'She / her (elle)')
    const r = await resolved(field('Pronouns', 'checkboxgroup', PRONOUNS))
    expect(r).toMatchObject({ tier: 'auto', key: 'pronouns', value: 'She / her (elle)' })
    expect(r.identifiedValue).toBeUndefined()
    expect(codex).not.toHaveBeenCalled()
  })

  it('a learned Option the group does not offer changes nothing', async () => {
    await learn('pronouns', 'she/her', 'She / her (elle)')
    const r = await resolved(field('Pronouns', 'checkboxgroup', ['He/him', 'They/them']))
    expect(r).toMatchObject({ tier: 'needs_input', value: null })
  })
})

describe('a Saved answer that equals none of the Options', () => {
  it('under a recognized key, the row names the Saved answer it stands for, so its pick is never learned for the key', async () => {
    setAnswerBank(db, { relocate: '' })
    const id = upsertAnswer(db, {
      questionNormalized: normalizeQuestion(RELOCATE), questionRaw: RELOCATE,
      answer: 'Happy to move for the right role.', language: 'en', reusability: 'reusable',
    })
    const r = await resolved(field(RELOCATE, 'select', RELOCATE_OPTIONS))
    expect(r).toMatchObject({ tier: 'needs_input', value: null, answerId: id, identifiedValue: 'Happy to move for the right role.' })
  })
})

describe('a wording that gives a different answer from the Value is never learned', () => {
  const STAY = 'No, I prefer to stay where I am'

  it('an Option that opens with the opposite yes or no is refused, and the next Resolution does not carry it', async () => {
    expect(await learn('relocate', 'Yes', STAY)).toEqual({ learned: false })
    const r = await resolved(field(RELOCATE, 'select', RELOCATE_OPTIONS))
    expect(r.candidates).not.toContain(STAY)
  })

  it('a bare opposite word is refused, so a plain Yes/No dropdown never turns ambiguous', async () => {
    expect(await learn('relocate', 'Yes', 'No')).toEqual({ learned: false })
    expect(learnedWordingsFor(db, 'relocate', 'Yes')).toEqual([])
  })

  it('the same in Portuguese', async () => {
    expect(await learn('relocate', 'Sim', 'Não, prefiro ficar onde estou')).toEqual({ learned: false })
  })

  it('a work-authorization no picked for a derived yes is refused, so the next Fill never claims it alone', async () => {
    expect(await learn('workAuth', 'Yes', 'No, I am not authorized')).toEqual({ learned: false })
    const r = await resolved(field('Are you legally authorized to work in Germany?', 'select', ['Select...', 'Yes, I am authorized', 'No, I am not authorized']))
    expect(r).toMatchObject({ key: 'workAuth', value: 'Yes' })
    expect(r.candidates).not.toContain('No, I am not authorized')
  })

  it('a wording already learned for the other answer is refused', async () => {
    expect(await learn('relocate', 'No', 'I would rather not')).toEqual({ learned: true })
    expect(await learn('relocate', 'Yes', 'I would rather not')).toEqual({ learned: false })
  })

  it('a yes or a no is never learned for a place', async () => {
    expect(await learn('country', 'France', 'Yes')).toEqual({ learned: false })
  })

  it('another country is never learned for a country', async () => {
    expect(await learn('country', 'France', 'Germany')).toEqual({ learned: false })
    expect(await learn('country', 'France', 'République française')).toEqual({ learned: true })
  })
})

describe('a country code and a yes or no under the same key', () => {
  it('are learned under different forms, so Norway never meets a residence no', async () => {
    expect(learnedValueOf('country', 'Norway')).not.toBe(learnedValueOf('country', 'No'))
    await learn('country', 'Norway', 'Kingdom of Norway')
    expect(learnedWordingsFor(db, 'country', 'No')).toEqual([])
    expect(learnedWordingsFor(db, 'country', 'Norway')).toEqual(['Kingdom of Norway'])
  })
})

describe('wording.learn', () => {
  it('refuses a key outside the closed set', async () => {
    const r = await handleRequest(deps, { requestId: crypto.randomUUID(), method: 'wording.learn', params: { key: 'nationality', value: 'yes', wording: 'Yes' } } as never)
    expect(r.ok).toBe(false)
  })
})
