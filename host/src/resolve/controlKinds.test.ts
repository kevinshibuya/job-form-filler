import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField, Resolution, WidgetKind } from '@jff/shared'
import { openDb, saveLearnedMapping, setAnswerBank, setProfile, upsertAnswer } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'
import { normalizeQuestion } from './normalize.js'

// Every test here is one `resolve` request through the host's request handler,
// with a real in-memory database and a fake Mapping runner. What is asserted is
// what the panel would receive: the Resolution of each Field, and what Mapping
// was asked.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string; answerId?: number }

let db: Database.Database
let deps: HandlerDeps
let mapping: ReturnType<typeof vi.fn>
let decide: (ref: string) => Decision

const ADA = {
  firstName: 'Ada', fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+1 555 0100',
  location: 'London, UK', linkedin: 'https://www.linkedin.com/in/ada-lovelace',
  github: 'https://github.com/ada-lovelace',
}

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, ADA)
  setAnswerBank(db, { workAuth: 'Yes', pronouns: 'she/her' })
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
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

let fid = 0
const field = (label: string, kind: WidgetKind, extra: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid: fid++, epoch: 3, label, name: null, idAttr: null, kind,
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...extra,
})

async function resolve(...fields: EnumField[]): Promise<Resolution[]> {
  const r = await handleRequest(deps, {
    requestId: crypto.randomUUID(), method: 'resolve',
    params: {
      epoch: 3, url: 'https://jobs.lever.co/acme/1', hostname: 'jobs.lever.co',
      company: 'Acme', jobText: 'Engineer wanted.', fields,
    },
  })
  if (!r.ok) throw new Error(`resolve failed: ${JSON.stringify(r)}`)
  return (r.result as { resolutions: Resolution[] }).resolutions
}

const mappingPrompt = (): string => (mapping.mock.calls[0]?.[0] as string | undefined) ?? ''
const refOf = (f: EnumField): string => `${f.frameId}:${f.fid}`

const TEXT_CONTROLS: WidgetKind[] = ['text', 'textarea']
const CHOICE_CONTROLS: WidgetKind[] = ['select', 'combobox', 'radiogroup', 'choice']
const YES_NO = ['Yes', 'No']

describe('a Known key answers only a Control that can hold its Value', () => {
  it('a link, phone or text key answers a text box and a text area', async () => {
    for (const kind of TEXT_CONTROLS) {
      const [linkedin, phone, email] = await resolve(field('LinkedIn URL', kind), field('Phone', kind), field('Email', kind))
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
      const out = await resolve(...fields)
      for (const r of out) expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
      expect(mapping).toHaveBeenCalledTimes(1)
      for (const f of fields) expect(mappingPrompt()).toContain(`ref=${refOf(f)} kind=${kind}`)
    }
  })

  it('a yes/no key still answers a radio group, a dropdown, a combobox, yes/no buttons and a text box', async () => {
    for (const kind of ['radiogroup', 'select', 'combobox', 'choice', 'text'] as WidgetKind[]) {
      const [r] = await resolve(field('Are you legally authorized to work in Brazil?', kind, { options: kind === 'text' ? [] : YES_NO }))
      expect(r).toMatchObject({ tier: 'auto', key: 'workAuth', value: 'Yes' })
    }
  })

  it('a Control kind the rule does not list takes no Known key', async () => {
    const unlisted = 'signature' as WidgetKind
    const [file, other] = await resolve(field('LinkedIn profile (PDF)', 'file'), field('Email', unlisted))
    expect(file).toMatchObject({ key: null, value: null })
    expect(file!.tier).not.toBe('auto')
    expect(other).toMatchObject({ key: null, value: null })
    expect(other!.tier).not.toBe('auto')
  })

  it('a yes/no question that mentions where the applicant is based does not receive the location line', async () => {
    const based = field('Are you based in US or Canada?', 'choice', { options: YES_NO, required: true })
    const [r] = await resolve(based)
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
    // It reached Mapping, told its Control kind and its Options.
    expect(mappingPrompt()).toContain(`ref=${refOf(based)} kind=choice`)
    expect(mappingPrompt()).toContain('<option>Yes</option><option>No</option>')
  })

  it('a recognizer hit on the wrong Control goes on to the exact Saved answer match', async () => {
    upsertAnswer(db, {
      questionNormalized: normalizeQuestion('Are you based in US or Canada?'), questionRaw: 'Are you based in US or Canada?',
      answer: 'No', language: 'en', reusability: 'reusable',
    })
    const [r] = await resolve(field('Are you based in US or Canada?', 'choice', { options: YES_NO }))
    expect(r).toMatchObject({ tier: 'auto', source: 'saved_answer', key: null, value: 'No' })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('a learned mapping on the wrong Control is refused the same way', async () => {
    saveLearnedMapping(db, normalizeQuestion('Where do you live today?'), 'location')
    const [onText] = await resolve(field('Where do you live today?', 'text'))
    expect(onText).toMatchObject({ tier: 'auto', key: 'location', value: ADA.location })
    const [onChoice] = await resolve(field('Where do you live today?', 'select', { options: ['Brazil', 'Elsewhere'] }))
    expect(onChoice).toMatchObject({ tier: 'needs_input', key: null, value: null })
  })

  it('a Known key Mapping names for a Control that cannot hold it leaves the Field Needs input', async () => {
    const source = field('How did you hear about us?', 'select', { options: ['LinkedIn', 'Referral', 'Other'] })
    decide = () => ({ decision: 'known_key', knownKey: 'linkedin' })
    const [r] = await resolve(source)
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
  })

  it('a Known key Mapping names for a Control that can hold it is still proposed', async () => {
    const auth = field('Can you work for us without restrictions?', 'radiogroup', { options: YES_NO })
    decide = () => ({ decision: 'known_key', knownKey: 'workAuth' })
    const [r] = await resolve(auth)
    expect(r).toMatchObject({ tier: 'proposed', key: 'workAuth', value: 'Yes' })
  })

  it('a Value already on the page carries no Known key its Control cannot hold', async () => {
    const [onSelect] = await resolve(field('LinkedIn', 'select', { options: ['LinkedIn', 'Other'], currentValue: 'LinkedIn' }))
    expect(onSelect).toMatchObject({ tier: 'auto', source: 'page', key: null, value: 'LinkedIn' })
    const [onText] = await resolve(field('LinkedIn URL', 'text', { currentValue: ADA.linkedin }))
    expect(onText).toMatchObject({ tier: 'auto', source: 'page', key: 'linkedin' })
  })
})

describe('a lone checkbox is a Consent checkbox', () => {
  it('a checkbox labelled "LinkedIn" resolves as Needs input with no Known key and no Value', async () => {
    const [r] = await resolve(field('LinkedIn', 'checkbox', { name: 'source', required: true }))
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null, source: null })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('a lone checkbox whose text mentions email resolves as Needs input with no Known key', async () => {
    const [r] = await resolve(field('I agree Acme may send me news about open roles by phone and email.', 'checkbox'))
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('a required lone checkbox flagged as demographic resolves as Needs input, not Skipped', async () => {
    const [r] = await resolve(field('I consent to Acme processing my self-identification answers.', 'checkbox', { required: true, demographic: true }))
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('a Consent checkbox already ticked on the page is still Needs input', async () => {
    const [r] = await resolve(field('I certify the information provided is accurate', 'checkbox', { currentValue: 'true' }))
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null, source: null })
  })

  it('a Saved answer under the same wording never ticks a Consent checkbox', async () => {
    upsertAnswer(db, {
      questionNormalized: normalizeQuestion('I agree to the privacy notice'), questionRaw: 'I agree to the privacy notice',
      answer: 'true', language: 'en', reusability: 'reusable',
    })
    const [r] = await resolve(field('I agree to the privacy notice', 'checkbox'))
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null, answerId: null })
  })
})

describe('a checkbox group takes no Known key', () => {
  it('a pronoun checkbox group takes no Known key and goes to Mapping, told its Control kind and Options', async () => {
    const pronouns = field('Pronouns', 'checkboxgroup', { options: ['He/him', 'She/her', 'They/them'] })
    const [r] = await resolve(pronouns)
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
    expect(mappingPrompt()).toContain(`ref=${refOf(pronouns)} kind=checkboxgroup`)
    expect(mappingPrompt()).toContain('She/her')
  })

  it('a checkbox group under a demographic heading is one Skipped Resolution', async () => {
    const group = field('Which of these describe you?', 'checkboxgroup', { options: ['Option A', 'Option B'], demographic: true })
    const out = await resolve(group)
    expect(out).toEqual([expect.objectContaining({ tier: 'skipped', value: null, key: null })])
  })
})
