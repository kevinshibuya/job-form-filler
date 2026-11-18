import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField, FieldHandle, Resolution, WidgetKind } from '@jff/shared'
import { openDb, saveLearnedMapping, setAnswerBank, setProfile, upsertAnswer } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'
import { normalizeQuestion } from './normalize.js'

// Every test here sends the Resolution requests through the host's request
// handler, with a real in-memory database and a fake Mapping runner. A recognizer
// hit, a Saved answer match, a Skipped Field and a Value already on the page are
// asserted on `resolve.first`; what Mapping decides, and what it was asked, on
// `resolve.mapping`. What is asserted is what the panel would receive.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string; answerId?: number }

let db: Database.Database
let deps: HandlerDeps
let mapping: ReturnType<typeof vi.fn>
let decide: (ref: string) => Decision

const ADA = {
  firstName: 'Ada', fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100',
  location: 'London, UK', linkedin: 'https://www.linkedin.com/in/ada-lovelace',
  github: 'https://github.com/ada-lovelace',
}

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, ADA)
  setAnswerBank(db, { workAuth: '["gb"]', pronouns: 'she/her' })
  decide = () => ({ decision: 'custom' })
  mapping = vi.fn(async (prompt: string) => {
    const refs = [...prompt.matchAll(/^- ref=(\S+)/gm)].map((m) => m[1]!)
    return refs.map((ref) => {
      const d = decide(ref)
      return { ref, decision: d.decision, knownKey: d.knownKey ?? null, answerId: d.answerId ?? null }
    })
  })
  const unused = { complete: vi.fn(async () => { throw new Error('claude is not part of Resolution') }) }
  deps = {
    db,
    runner: unused as unknown as HandlerDeps['runner'],
    codex: { complete: mapping } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

let fid = 0
const field = (label: string, kind: WidgetKind, extra: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid: fid++, epoch: 3, label, name: null, idAttr: null, kind,
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...extra,
})

async function send<T>(method: 'resolve.first' | 'resolve.mapping', fields: EnumField[]): Promise<T> {
  const r = await handleRequest(deps, {
    requestId: crypto.randomUUID(), method,
    params: {
      epoch: 3, url: 'https://jobs.lever.co/acme/1', hostname: 'jobs.lever.co',
      company: 'Acme', jobText: 'Engineer wanted.', fields,
    },
  })
  if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r)}`)
  return r.result as T
}

/** A Field `resolve.first` leaves for Mapping. */
const PENDING = 'pending' as const

/** `resolve.first`: each Field's Resolution, or PENDING, in Field order. */
async function first(...fields: EnumField[]): Promise<(Resolution | typeof PENDING)[]> {
  const r = await send<{ resolutions: Resolution[]; pending: FieldHandle[] }>('resolve.first', fields)
  return fields.map((f) => {
    const decided = r.resolutions.find((x) => x.handle.fid === f.fid)
    if (decided !== undefined) return decided
    if (r.pending.some((h) => h.fid === f.fid)) return PENDING
    throw new Error(`resolve.first neither decided nor left pending fid ${f.fid}`)
  })
}

/** `resolve.mapping` over the given Fields: their Resolutions, in Field order. */
async function mapped(...fields: EnumField[]): Promise<Resolution[]> {
  return (await send<{ resolutions: Resolution[] }>('resolve.mapping', fields)).resolutions
}

const mappingPrompt = (): string => (mapping.mock.calls[0]?.[0] as string | undefined) ?? ''
const refOf = (f: EnumField): string => `${f.frameId}:${f.fid}`

const TEXT_CONTROLS: WidgetKind[] = ['text', 'textarea']
const CHOICE_CONTROLS: WidgetKind[] = ['select', 'combobox', 'radiogroup', 'choice']
const YES_NO = ['Yes', 'No']

describe('a Known key answers only a Control that can hold its Value', () => {
  it('a link, phone or text key answers a text box and a text area', async () => {
    for (const kind of TEXT_CONTROLS) {
      const [linkedin, phone, email] = await first(field('LinkedIn URL', kind), field('Phone', kind), field('Email', kind))
      expect(linkedin).toMatchObject({ tier: 'auto', key: 'linkedin', value: ADA.linkedin })
      expect(phone).toMatchObject({ tier: 'auto', key: 'phone', value: ADA.phone })
      expect(email).toMatchObject({ tier: 'auto', key: 'email', value: ADA.email })
    }
  })

  it('a link, phone or text key answers no choice Control, and the Field goes to Mapping instead', async () => {
    for (const kind of CHOICE_CONTROLS) {
      mapping.mockClear()
      const fields = [
        field('LinkedIn', kind, { options: ['LinkedIn', 'Referral', 'Other'] }),
        field('Phone', kind, { options: ['Mobile', 'Home'] }),
        field('Email', kind, { options: YES_NO }),
      ]
      expect(await first(...fields)).toEqual([PENDING, PENDING, PENDING])
      expect(mapping).not.toHaveBeenCalled()
      const out = await mapped(...fields)
      for (const r of out) expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
      expect(mapping).toHaveBeenCalledTimes(1)
      for (const f of fields) expect(mappingPrompt()).toContain(`ref=${refOf(f)} kind=${kind}`)
    }
  })

  it('a yes/no key still answers a radio group, a dropdown, a combobox, yes/no buttons and a text box', async () => {
    for (const kind of ['radiogroup', 'select', 'combobox', 'choice', 'text'] as WidgetKind[]) {
      const [r] = await first(field('Are you legally authorized to work in the United Kingdom?', kind, { options: kind === 'text' ? [] : YES_NO }))
      expect(r).toMatchObject({ tier: 'auto', key: 'workAuth', value: 'Yes' })
    }
  })

  it('a place key answers a text box and every choice Control, and no checkbox group', async () => {
    setProfile(db, { country: 'United Kingdom' })
    for (const kind of [...TEXT_CONTROLS, ...CHOICE_CONTROLS]) {
      const [r] = await first(field('Country', kind, { options: kind === 'text' || kind === 'textarea' ? [] : ['France', 'United Kingdom'] }))
      expect(r, kind).toMatchObject({ tier: 'auto', key: 'country', value: 'United Kingdom' })
    }
    const group = field('Country', 'checkboxgroup', { options: ['France', 'United Kingdom'] })
    expect(await first(group)).toEqual([PENDING])
  })

  it('a Control kind the rule does not list takes no Known key', async () => {
    const unlisted = 'signature' as WidgetKind
    const fields = [field('LinkedIn profile (PDF)', 'file'), field('Email', unlisted)]
    expect(await first(...fields)).toEqual([PENDING, PENDING])
    const [file, other] = await mapped(...fields)
    expect(file).toMatchObject({ key: null, value: null })
    expect(file!.tier).not.toBe('auto')
    expect(other).toMatchObject({ key: null, value: null })
    expect(other!.tier).not.toBe('auto')
  })

  it('a yes/no question that mentions where the applicant is based does not receive the location line', async () => {
    // One that names a country is answered from the stored country instead
    // (countryAnswers.test.ts); this one names a city.
    const based = field('Are you based in London?', 'choice', { options: YES_NO, required: true })
    expect(await first(based)).toEqual([PENDING])
    const [r] = await mapped(based)
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
    // It reached Mapping, told its Control kind and its Options.
    expect(mappingPrompt()).toContain(`ref=${refOf(based)} kind=choice`)
    expect(mappingPrompt()).toContain('<option>Yes</option><option>No</option>')
  })

  it('a recognizer hit on the wrong Control goes on to the exact Saved answer match', async () => {
    upsertAnswer(db, {
      questionNormalized: normalizeQuestion('Are you based in London?'), questionRaw: 'Are you based in London?',
      answer: 'No', language: 'en', reusability: 'reusable',
    })
    const [r] = await first(field('Are you based in London?', 'choice', { options: YES_NO }))
    expect(r).toMatchObject({ tier: 'auto', source: 'saved_answer', key: null, value: 'No' })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('a learned mapping on the wrong Control is refused the same way', async () => {
    saveLearnedMapping(db, normalizeQuestion('Where do you live today?'), 'location')
    const [onText] = await first(field('Where do you live today?', 'text'))
    expect(onText).toMatchObject({ tier: 'auto', key: 'location', value: ADA.location })
    const choice = field('Where do you live today?', 'select', { options: ['Brazil', 'Elsewhere'] })
    expect(await first(choice)).toEqual([PENDING])
    const [onChoice] = await mapped(choice)
    expect(onChoice).toMatchObject({ tier: 'needs_input', key: null, value: null })
  })

  it('a Known key Mapping names for a Control that cannot hold it leaves the Field Needs input', async () => {
    const source = field('How did you hear about us?', 'select', { options: ['LinkedIn', 'Referral', 'Other'] })
    decide = () => ({ decision: 'known_key', knownKey: 'linkedin' })
    expect(await first(source)).toEqual([PENDING])
    const [r] = await mapped(source)
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
  })

  it('a Known key Mapping names for a Control that can hold it is still proposed', async () => {
    // It names no country, so the answer is the one for the stored country.
    setProfile(db, { country: 'United Kingdom' })
    const auth = field('Can you work for us without restrictions?', 'radiogroup', { options: YES_NO })
    decide = () => ({ decision: 'known_key', knownKey: 'workAuth' })
    expect(await first(auth)).toEqual([PENDING])
    const [r] = await mapped(auth)
    expect(r).toMatchObject({ tier: 'proposed', key: 'workAuth', value: 'Yes' })
  })

  // PR #36 manual pass: an address box whose label mentions relocating took "Yes".
  const ADDRESS = 'What is the address from which you plan on working? If you would need to relocate, please type "relocating".'

  it('a yes or a no is typed into a text box only under a yes/no question', async () => {
    setAnswerBank(db, { relocate: 'yes' })
    for (const kind of TEXT_CONTROLS) {
      expect(await first(field(ADDRESS, kind))).toEqual([PENDING])
      expect(await first(field('Relocation plans (the city you would move to)', kind))).toEqual([PENDING])
    }
    const [willing] = await first(field('Are you willing to relocate?', 'text'))
    expect(willing).toMatchObject({ tier: 'auto', key: 'relocate', value: 'Yes' })
  })

  it('a yes/no key Mapping names for a text box that asks no yes/no question is refused', async () => {
    setAnswerBank(db, { relocate: 'yes' })
    const address = field(ADDRESS, 'text')
    decide = () => ({ decision: 'known_key', knownKey: 'relocate' })
    const [r] = await mapped(address)
    expect(r).toMatchObject({ tier: 'needs_input', reason: 'llm-key:relocate:wrong-control' })
  })

  it('a page value under a label that asks no yes/no question is harvested with no yes/no key', async () => {
    const [r] = await first(field('Relocation plans (the city you would move to)', 'text', { currentValue: 'Paris' }))
    expect(r).toMatchObject({ tier: 'auto', source: 'page', key: null })
  })

  it('a Value already on the page carries no Known key its Control cannot hold', async () => {
    const [onSelect] = await first(field('LinkedIn', 'select', { options: ['LinkedIn', 'Other'], currentValue: 'LinkedIn' }))
    expect(onSelect).toMatchObject({ tier: 'auto', source: 'page', key: null, value: 'LinkedIn' })
    const [onText] = await first(field('LinkedIn URL', 'text', { currentValue: ADA.linkedin }))
    expect(onText).toMatchObject({ tier: 'auto', source: 'page', key: 'linkedin' })
  })
})

describe('a lone checkbox is a Consent checkbox', () => {
  it('a checkbox labelled "LinkedIn" resolves as Needs input with no Known key and no Value', async () => {
    const [r] = await first(field('LinkedIn', 'checkbox', { name: 'source', required: true }))
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null, source: null })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('a lone checkbox whose text mentions email resolves as Needs input with no Known key', async () => {
    const [r] = await first(field('I agree Acme may send me news about open roles by phone and email.', 'checkbox'))
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('a required lone checkbox flagged as demographic resolves as Needs input, not Skipped', async () => {
    const [r] = await first(field('I consent to Acme processing my self-identification answers.', 'checkbox', { required: true, demographic: true }))
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('a Consent checkbox already ticked on the page is still Needs input', async () => {
    const [r] = await first(field('I certify the information provided is accurate', 'checkbox', { currentValue: 'true' }))
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null, source: null })
  })

  it('a Saved answer under the same wording never ticks a Consent checkbox', async () => {
    upsertAnswer(db, {
      questionNormalized: normalizeQuestion('I agree to the privacy notice'), questionRaw: 'I agree to the privacy notice',
      answer: 'true', language: 'en', reusability: 'reusable',
    })
    const [r] = await first(field('I agree to the privacy notice', 'checkbox'))
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null, answerId: null })
  })
})

describe('a checkbox group takes only the pronouns Known key', () => {
  it('a pronoun checkbox group with an Option equal to the stored pronouns is filled with that Option', async () => {
    const [r] = await first(field('Pronouns', 'checkboxgroup', { options: ['He/him', 'She/Her', 'They/them'] }))
    expect(r).toMatchObject({ tier: 'auto', source: 'answer_bank', key: 'pronouns', value: 'She/Her' })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('a pronoun checkbox group with no equal Option goes to Mapping, told its Control kind and Options', async () => {
    const pronouns = field('Pronouns', 'checkboxgroup', { options: ['He/him', 'They/them', 'Xe/xem'] })
    expect(await first(pronouns)).toEqual([PENDING])
    const [r] = await mapped(pronouns)
    // The row names the pronouns key, so an Option accepted for it is learned (ticket #35).
    expect(r).toMatchObject({ tier: 'needs_input', key: 'pronouns', value: null })
    expect(mappingPrompt()).toContain(`ref=${refOf(pronouns)} kind=checkboxgroup`)
    expect(mappingPrompt()).toContain('Xe/xem')
  })

  it('a pronoun text box is still answered from the stored Value', async () => {
    const [r] = await first(field('Pronouns', 'text'))
    expect(r).toMatchObject({ tier: 'auto', key: 'pronouns', value: 'she/her' })
  })

  it('a link, phone or text key answers no checkbox group, even with an Option equal to the stored Value', async () => {
    const group = field('LinkedIn', 'checkboxgroup', { options: [ADA.linkedin, 'Other'] })
    expect(await first(group)).toEqual([PENDING])
    const [r] = await mapped(group)
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
  })

  it('a checkbox group under a demographic heading is one Skipped Resolution', async () => {
    const group = field('Which of these describe you?', 'checkboxgroup', { options: ['Option A', 'Option B'], demographic: true })
    const out = await first(group)
    expect(out).toEqual([expect.objectContaining({ tier: 'skipped', value: null, key: null })])
  })
})
