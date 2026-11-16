import { describe, it, expect, beforeEach, vi } from 'vitest'
import { yesNoCandidates, type EnumField, type Resolution, type WidgetKind } from '@jff/shared'
import type Database from 'better-sqlite3'
import { getAnswerBank, getProfile, openDb, setAnswerBank, setProfile } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { buildProfileSummary } from '../llm/generate.js'
import { resolveModels } from '../llm/models.js'

// Ticket #27: `relocate` is stored as a yes or a no and `phone` in
// international form. A stored text is a Value only when it already is that
// form; old text has no Value, and a Field mapped to the key is Needs input.
// Every test goes through the host's request handler with a real in-memory
// database and a fake Mapping runner (spec #6, testing decision 2). The
// persona is Ada Lovelace; her country is not the maintainer's.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string }

let db: Database.Database
let deps: HandlerDeps
let decide: (ref: string) => Decision

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, {
    firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100',
    country: 'United States',
  })
  decide = () => ({ decision: 'custom' })
  const mapping = vi.fn(async (prompt: string) =>
    [...prompt.matchAll(/^- ref=(\S+)/gm)].map((m) => {
      const d = decide(m[1]!)
      return { ref: m[1]!, decision: d.decision, knownKey: d.knownKey ?? null, answerId: null }
    }))
  const unused = { complete: vi.fn(async () => { throw new Error('claude is not part of Resolution') }) }
  deps = {
    db,
    runner: unused as unknown as HandlerDeps['runner'],
    codex: { complete: mapping } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

let fid = 0
const field = (label: string, kind: WidgetKind, extra: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid: fid++, epoch: 5, label, name: null, idAttr: null, kind,
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...extra,
})

async function resolve(method: 'resolve.first' | 'resolve.mapping', ...fields: EnumField[]): Promise<Resolution[]> {
  const r = await handleRequest(deps, {
    requestId: crypto.randomUUID(), method,
    params: { epoch: 5, url: 'https://jobs.example.com/acme/1', hostname: 'jobs.example.com', company: 'Acme', jobText: 'Engineer wanted.', fields },
  })
  if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r)}`)
  const { resolutions } = r.result as { resolutions: Resolution[] }
  return fields.map((f) => resolutions.find((x) => x.handle.fid === f.fid)!)
}

async function write(method: 'profile.set' | 'answerBank.set', values: Record<string, string>) {
  return handleRequest(deps, { requestId: crypto.randomUUID(), method, params: { values } })
}

const RELOCATE_RADIOS = (): EnumField => field('Are you willing to relocate?', 'radiogroup', { options: ['Yes', 'No'] })

describe('relocate is a yes or a no', () => {
  it('a relocate stored before this ticket as free text has no Value: the Field is Needs input with the reason', async () => {
    setAnswerBank(db, { relocate: 'Yes, anywhere in Europe' })
    const [radios, text] = await resolve('resolve.first', RELOCATE_RADIOS(), field('Are you willing to relocate?', 'text'))
    for (const r of [radios, text]) {
      expect(r).toMatchObject({ tier: 'needs_input', key: 'relocate', value: null })
      expect(r!.reason).toMatch(/no-value$/)
    }
  })

  it('a stored relocate of exactly yes is a Value; "Yes, anywhere in Europe" is old text', async () => {
    setAnswerBank(db, { relocate: 'yes' })
    const [value] = await resolve('resolve.first', RELOCATE_RADIOS())
    expect(value).toMatchObject({ tier: 'auto', key: 'relocate' })
    setAnswerBank(db, { relocate: 'Yes, anywhere in Europe' })
    const [old] = await resolve('resolve.first', RELOCATE_RADIOS())
    expect(old).toMatchObject({ tier: 'needs_input', key: 'relocate' })
  })

  it('a yes resolves a radio group offering "Yes" and "No" as an auto-fill whose Fill carries the yes candidates', async () => {
    const w = await write('answerBank.set', { relocate: 'yes' })
    expect(w.ok).toBe(true)
    const [r] = await resolve('resolve.first', RELOCATE_RADIOS())
    expect(r).toMatchObject({ tier: 'auto', source: 'answer_bank', key: 'relocate', value: 'Yes' })
    expect(r!.candidates).toEqual(yesNoCandidates('yes'))
    expect(r!.candidates).toEqual(expect.arrayContaining(['Yes', 'Sim']))
  })

  it('the same Value gives "Sim" on a Portuguese text box and "Yes" on an English one', async () => {
    setAnswerBank(db, { relocate: 'yes' })
    const [pt, en] = await resolve('resolve.first',
      field('Você está disposto a mudar de cidade?', 'text'),
      field('Are you willing to relocate?', 'text'))
    expect(pt).toMatchObject({ tier: 'auto', key: 'relocate', value: 'Sim' })
    expect(en).toMatchObject({ tier: 'auto', key: 'relocate', value: 'Yes' })
  })

  it('a no is written "No" and carries the no candidates', async () => {
    setAnswerBank(db, { relocate: 'no' })
    const [r] = await resolve('resolve.first', RELOCATE_RADIOS())
    expect(r).toMatchObject({ tier: 'auto', value: 'No' })
    expect(r!.candidates).toEqual(expect.arrayContaining(['No', 'Não']))
  })

  it('a relocate Mapping proposes on old text is Needs input with the reason', async () => {
    setAnswerBank(db, { relocate: 'maybe later' })
    decide = () => ({ decision: 'known_key', knownKey: 'relocate' })
    const [r] = await resolve('resolve.mapping', field('Open to moving for this role?', 'select', { options: ['Yes', 'No'] }))
    expect(r).toMatchObject({ tier: 'needs_input', value: null })
    expect(r!.reason).toMatch(/no-value$/)
  })

  it('a write of relocate takes a yes or a no word and stores yes or no; anything else is refused', async () => {
    expect((await write('answerBank.set', { relocate: 'Sim' })).ok).toBe(true)
    expect(getAnswerBank(db)['relocate']).toBe('yes')
    expect((await write('answerBank.set', { relocate: 'no' })).ok).toBe(true)
    expect(getAnswerBank(db)['relocate']).toBe('no')
    const refused = await write('answerBank.set', { relocate: 'Yes, anywhere in Europe' })
    expect(refused).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect(getAnswerBank(db)['relocate']).toBe('no')
  })
})

describe('phone is stored in international form', () => {
  it('a phone stored before this ticket has no Value, and a phone Field is Needs input', async () => {
    setProfile(db, { phone: '(555) 010-0100' })
    const [r] = await resolve('resolve.first', field('Phone', 'text'))
    expect(r).toMatchObject({ tier: 'needs_input', key: 'phone', value: null })
    expect(r!.reason).toMatch(/no-value$/)
    setProfile(db, { phone: '+1 555 0100' })
    const [spaced] = await resolve('resolve.first', field('Phone', 'text'))
    expect(spaced).toMatchObject({ tier: 'needs_input', key: 'phone' })
  })

  it('a phone box receives the stored international form', async () => {
    const [r] = await resolve('resolve.first', field('Mobile phone', 'text'))
    expect(r).toMatchObject({ tier: 'auto', source: 'profile', key: 'phone', value: '+15550100' })
  })

  it('a phone written as "+1 555 0100" is stored as "+15550100"', async () => {
    const w = await write('profile.set', { phone: '+1 (555) 010-0100' })
    expect(w.ok).toBe(true)
    expect(getProfile(db)['phone']).toBe('+15550100100')
    await write('profile.set', { phone: '+1 555 0100' })
    expect(getProfile(db)['phone']).toBe('+15550100')
  })

  it('a phone without a plus sign is refused, and the stored phone stays', async () => {
    const r = await write('profile.set', { phone: '(555) 010-0100', email: 'other@example.com' })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect(r.ok === false && r.error.message).toMatch(/international/)
    expect(getProfile(db)).toMatchObject({ phone: '+15550100', email: 'ada@example.com' })
  })

  it('an empty phone write still deletes it', async () => {
    expect((await write('profile.set', { phone: '' })).ok).toBe(true)
    expect('phone' in getProfile(db)).toBe(false)
  })
})

describe('the keys this ticket leaves as they are', () => {
  // salary and the per-language keys took a typed form in ticket #33
  // (salaryAndLanguage.test.ts); pronouns still stores any text.
  it('pronouns stores and answers any text, as before', async () => {
    expect((await write('answerBank.set', { pronouns: 'she/her' })).ok).toBe(true)
    expect(getAnswerBank(db)).toMatchObject({ pronouns: 'she/her' })
    const [r] = await resolve('resolve.first', field('Pronouns', 'text'))
    expect([r!.tier, r!.key, r!.value]).toEqual(['auto', 'pronouns', 'she/her'])
    expect(r!.candidates ?? []).toEqual([])
  })
})

describe('a Value handed to a model', () => {
  it('the profile summary formats typed Values and leaves old text out', () => {
    const summary = buildProfileSummary({ phone: '+15550100', email: 'ada@example.com' }, { relocate: 'yes', pronouns: 'she/her' })
    expect(summary).toContain('phone: +15550100')
    expect(summary).toContain('relocate: Yes')
    expect(summary).toContain('pronouns: she/her')
    const old = buildProfileSummary({ phone: '(555) 010-0100' }, { relocate: 'Yes, anywhere in Europe' })
    expect(old).not.toContain('555')
    expect(old).not.toContain('Europe')
  })
})
