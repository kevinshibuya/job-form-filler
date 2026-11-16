import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField, FieldHandle, Resolution, WidgetKind } from '@jff/shared'
import { openDb, setProfile } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'

// Ticket #25: city, region, country, current company and current title. Every
// test sends the Resolution requests through the host's request handler with a
// real in-memory database and a fake Mapping runner, and asserts what the panel
// would receive. The persona is Ada Lovelace; her country is not the maintainer's.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string; answerId?: number }

let db: Database.Database
let deps: HandlerDeps
let mapping: ReturnType<typeof vi.fn>
let decide: (ref: string) => Decision

const ADA = {
  firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+1 555 0100',
  location: 'London, UK', city: 'London', region: 'Greater London', country: 'United Kingdom',
  currentCompany: 'Analytical Engines Ltd', currentTitle: 'Mathematician',
}

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, ADA)
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

async function send<T>(method: 'resolve.first' | 'resolve.mapping', fields: EnumField[]): Promise<T> {
  const r = await handleRequest(deps, {
    requestId: crypto.randomUUID(), method,
    params: {
      epoch: 3, url: 'https://boards.greenhouse.io/acme/jobs/1', hostname: 'boards.greenhouse.io',
      company: 'Acme', jobText: 'Engineer wanted.', fields,
    },
  })
  if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r)}`)
  return r.result as T
}

const PENDING = 'pending' as const

async function first(...fields: EnumField[]): Promise<(Resolution | typeof PENDING)[]> {
  const r = await send<{ resolutions: Resolution[]; pending: FieldHandle[] }>('resolve.first', fields)
  return fields.map((f) => {
    const decided = r.resolutions.find((x) => x.handle.fid === f.fid)
    if (decided !== undefined) return decided
    if (r.pending.some((h) => h.fid === f.fid)) return PENDING
    throw new Error(`resolve.first neither decided nor left pending fid ${f.fid}`)
  })
}

async function mapped(...fields: EnumField[]): Promise<Resolution[]> {
  return (await send<{ resolutions: Resolution[] }>('resolve.mapping', fields)).resolutions
}

const COUNTRIES = ['Brazil', 'Canada', 'United Kingdom', 'United States']
const YES_NO = ['Yes', 'No']

describe('a Country dropdown', () => {
  it('resolves to country in resolve.first with no model call, its Options known at Scan', async () => {
    const [r] = await first(field('Country', 'select', { options: COUNTRIES }))
    expect(r).toMatchObject({ tier: 'auto', source: 'profile', key: 'country', value: 'United Kingdom' })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('resolves to country with its Options unknown at Scan', async () => {
    for (const kind of ['combobox', 'select'] as WidgetKind[]) {
      const [r] = await first(field('Country of residence *', kind))
      expect(r).toMatchObject({ tier: 'auto', key: 'country', value: 'United Kingdom' })
    }
    expect(mapping).not.toHaveBeenCalled()
  })

  it('sends the stored text even when no Option spells it the same way', async () => {
    // Fill's own comparison decides; Resolution never refuses a place over Options.
    const [r] = await first(field('País', 'select', { options: ['Brasil', 'Reino Unido'] }))
    expect(r).toMatchObject({ tier: 'auto', key: 'country', value: 'United Kingdom' })
  })

  it('is Needs input under country when no country is stored, and never takes the location line', async () => {
    setProfile(db, { country: '' })
    const [r] = await first(field('Country', 'select', { options: COUNTRIES }))
    expect(r).toMatchObject({ tier: 'needs_input', key: 'country', value: null })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('never receives the location line when Mapping names location for it', async () => {
    const country = field('Where in the world?', 'select', { options: COUNTRIES })
    decide = () => ({ decision: 'known_key', knownKey: 'location' })
    expect(await first(country)).toEqual([PENDING])
    const [r] = await mapped(country)
    expect(r!.value).not.toBe(ADA.location)
    expect(r).toMatchObject({ tier: 'needs_input', value: null })
  })

  it('is proposed the stored country when Mapping names country for it', async () => {
    const country = field('Where in the world?', 'select', { options: COUNTRIES })
    decide = () => ({ decision: 'known_key', knownKey: 'country' })
    const [r] = await mapped(country)
    expect(r).toMatchObject({ tier: 'proposed', source: 'llm_key', key: 'country', value: 'United Kingdom' })
  })
})

describe('city and location', () => {
  it('a dropdown labelled "Location (City)" resolves to city', async () => {
    const [r] = await first(field('Location (City)', 'combobox'))
    expect(r).toMatchObject({ tier: 'auto', key: 'city', value: 'London' })
  })

  it('a dropdown labelled "Location" resolves to city, never to the location line', async () => {
    const [r] = await first(field('Location', 'select', { options: ['London', 'Paris'] }))
    expect(r).toMatchObject({ tier: 'auto', key: 'city', value: 'London' })
  })

  it('a text box labelled "City" resolves to city', async () => {
    for (const label of ['City', 'Cidade', 'Current location (city)']) {
      const [r] = await first(field(label, 'text'))
      expect(r, label).toMatchObject({ tier: 'auto', key: 'city', value: 'London' })
    }
  })

  it('a text box labelled "Location" or "Where are you based?" resolves to location', async () => {
    for (const label of ['Location', 'Where are you based?', 'Current location']) {
      const [r] = await first(field(label, 'text'))
      expect(r, label).toMatchObject({ tier: 'auto', key: 'location', value: ADA.location })
    }
  })

  it('a region Field resolves to region in English and Portuguese', async () => {
    for (const [label, kind] of [['State/Province', 'text'], ['Region', 'select'], ['Estado', 'select'], ['Província', 'text']] as const) {
      const [r] = await first(field(label, kind))
      expect(r, label).toMatchObject({ tier: 'auto', key: 'region', value: 'Greater London' })
    }
  })

  it('a free-text sentence that asks the applicant to state something is not a region', async () => {
    const [r] = await first(field('Please state why you want this role', 'textarea'))
    expect(r).toBe(PENDING)
  })
})

describe('current company and current title', () => {
  it.each([
    ['Current company', 'currentCompany', ADA.currentCompany],
    ['Current employer', 'currentCompany', ADA.currentCompany],
    ['Empresa atual', 'currentCompany', ADA.currentCompany],
    ['Nome da empresa atual', 'currentCompany', ADA.currentCompany],
    ['Current title', 'currentTitle', ADA.currentTitle],
    ['Current job title', 'currentTitle', ADA.currentTitle],
    ['Cargo atual', 'currentTitle', ADA.currentTitle],
    ['Nome do cargo atual', 'currentTitle', ADA.currentTitle],
  ])('a text box labelled %s resolves to %s with no model call', async (label, key, value) => {
    const [r] = await first(field(label, 'text'))
    expect(r).toMatchObject({ tier: 'auto', source: 'profile', key, value })
    expect(mapping).not.toHaveBeenCalled()
  })

  it('a current company or title answers no choice Control', async () => {
    const fields = [field('Current company', 'select', { options: ['Acme', 'Other'] }), field('Current title', 'radiogroup', { options: YES_NO })]
    expect(await first(...fields)).toEqual([PENDING, PENDING])
  })
})

describe('a question is not a place', () => {
  it('"Do you live in the US or Canada?" as a yes/no Field gets no place Value', async () => {
    for (const kind of ['radiogroup', 'select', 'choice', 'combobox'] as WidgetKind[]) {
      const q = field('Do you live in the US or Canada?', kind, { options: YES_NO })
      const [onFirst] = await first(q)
      if (onFirst !== PENDING) expect(onFirst.value).toBeNull()
      for (const knownKey of ['country', 'city', 'region']) {
        decide = () => ({ decision: 'known_key', knownKey })
        const [r] = await mapped(q)
        expect(r, `${kind} mapped to ${knownKey}`).toMatchObject({ value: null })
        expect([ADA.country, ADA.city, ADA.region, ADA.location]).not.toContain(r!.value)
      }
    }
  })

  it('a yes/no question that names the country word gets no place Value either', async () => {
    const q = field('Are you currently residing in the country of this role?', 'radiogroup', { options: YES_NO })
    const [r] = await first(q)
    if (r !== PENDING) expect(r.value).toBeNull()
    const pt = field('Você mora no país da vaga?', 'radiogroup', { options: ['Sim', 'Não'] })
    const [rp] = await first(pt)
    if (rp !== PENDING) expect(rp.value).toBeNull()
  })

  it('a yes/no question typed into a text box gets no place Value', async () => {
    const q = field('Do you live in the city of London?', 'text')
    const [r] = await first(q)
    if (r !== PENDING) expect(r.value).toBeNull()
  })
})

describe('Mapping and the twenty-three keys', () => {
  it('Mapping may return any of the five new keys', async () => {
    const fields = [
      field('Hometown', 'text'), field('Your area', 'text'), field('Nation', 'select', { options: COUNTRIES }),
      field('Who do you work for?', 'text'), field('What do you do there?', 'text'),
    ]
    const keys = ['city', 'region', 'country', 'currentCompany', 'currentTitle']
    decide = (ref) => ({ decision: 'known_key', knownKey: keys[fields.findIndex((f) => `${f.frameId}:${f.fid}` === ref)]! })
    const out = await mapped(...fields)
    expect(out.map((r) => [r.tier, r.key, r.value])).toEqual([
      ['proposed', 'city', 'London'],
      ['proposed', 'region', 'Greater London'],
      ['proposed', 'country', 'United Kingdom'],
      ['proposed', 'currentCompany', ADA.currentCompany],
      ['proposed', 'currentTitle', ADA.currentTitle],
    ])
    const prompt = mapping.mock.calls[0]![0] as string
    for (const k of keys) expect(prompt).toContain(k)
  })

  it('Mapping still rejects a key outside the twenty-three', async () => {
    const f = field('Nationality', 'select', { options: COUNTRIES })
    decide = () => ({ decision: 'known_key', knownKey: 'nationality' })
    const [r] = await mapped(f)
    expect(r).toMatchObject({ tier: 'needs_input', key: null, value: null })
  })
})

describe('the Profile stores the five keys', () => {
  it('profile.set accepts the five new keys and profile.get returns them', async () => {
    const set = await handleRequest(deps, {
      requestId: crypto.randomUUID(), method: 'profile.set',
      params: { values: { city: 'Paris', region: 'Île-de-France', country: 'France', currentCompany: 'Acme', currentTitle: 'Engineer' } },
    })
    expect(set.ok).toBe(true)
    const got = await handleRequest(deps, { requestId: crypto.randomUUID(), method: 'profile.get', params: {} })
    expect(got.ok && got.result).toMatchObject({ city: 'Paris', region: 'Île-de-France', country: 'France', currentCompany: 'Acme', currentTitle: 'Engineer' })
  })
})
