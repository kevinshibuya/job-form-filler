import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EnumField, Resolution, WidgetKind } from '@jff/shared'
import type Database from 'better-sqlite3'
import { openDb, setProfile } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'

// Ticket #32: the Resolution of a `city` Field whose Control is a type-to-search
// dropdown carries the names of the stored country beside the city, so the Fill
// can pick the result that names both. Every test goes through the host's
// request handler with a real in-memory database and a fake Mapping runner
// (spec #6, testing decision 2). The persona is Ada Lovelace; her city and
// country are not the maintainer's.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string }

let db: Database.Database
let deps: HandlerDeps
let decide: (ref: string) => Decision

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, {
    firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100',
    location: 'Cambridge, Cambridgeshire, United Kingdom', city: 'Cambridge', country: 'United Kingdom',
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
const field = (label: string, kind: WidgetKind = 'text', extra: Partial<EnumField> = {}): EnumField => ({
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

describe('the Resolution of a city Field on a dropdown carries the names of the stored country', () => {
  it('a City dropdown gets the city alone, with every name of the United Kingdom in both languages', async () => {
    const [city] = await resolve('resolve.first', field('City', 'combobox'))
    expect(city).toMatchObject({ tier: 'auto', key: 'city', value: 'Cambridge' })
    expect(city!.city!.countryNames).toEqual(expect.arrayContaining(['United Kingdom', 'UK', 'Reino Unido']))
    expect(city!.city!.countryNames).not.toContain('United States')
  })

  it('a City text box gets the city and no country names', async () => {
    const [city] = await resolve('resolve.first', field('City', 'text'))
    expect(city).toMatchObject({ tier: 'auto', key: 'city', value: 'Cambridge' })
    expect(city!.city).toBeUndefined()
  })

  it('a stored country outside the closed list is named by its own text', async () => {
    setProfile(db, { country: 'Atlantis' })
    const [city] = await resolve('resolve.first', field('City', 'combobox'))
    expect(city!.city).toEqual({ countryNames: ['Atlantis'] })
  })

  it('with no country stored the dropdown still gets the city, with no country names', async () => {
    setProfile(db, { country: '' })
    const [city] = await resolve('resolve.first', field('City', 'combobox'))
    expect(city).toMatchObject({ key: 'city', value: 'Cambridge' })
    expect(city!.city).toEqual({ countryNames: [] })
  })

  it('a city dropdown Mapping answers carries the names too', async () => {
    decide = () => ({ decision: 'known_key', knownKey: 'city' })
    const [city] = await resolve('resolve.mapping', field('Where do you live?', 'combobox'))
    expect(city).toMatchObject({ key: 'city', value: 'Cambridge' })
    expect(city!.city!.countryNames).toContain('United Kingdom')
  })

  it('no other Resolution carries city parts', async () => {
    const [email, country] = await resolve('resolve.first', field('Email'), field('Country', 'combobox'))
    expect(email!.city).toBeUndefined()
    expect(country!.city).toBeUndefined()
  })
})

describe('a city typeahead is never given the location line', () => {
  it('a Location dropdown is answered from the city, not the stored location line', async () => {
    const [loc] = await resolve('resolve.first', field('Location', 'combobox'))
    expect(loc).toMatchObject({ key: 'city', value: 'Cambridge' })
    expect(loc!.city!.countryNames).toContain('United Kingdom')
  })

  it('a Location text box keeps the location line, with no city parts', async () => {
    const [loc] = await resolve('resolve.first', field('Location', 'text'))
    expect(loc).toMatchObject({ key: 'location', value: 'Cambridge, Cambridgeshire, United Kingdom' })
    expect(loc!.city).toBeUndefined()
  })

  it('Mapping that answers a dropdown with the location line is refused', async () => {
    decide = () => ({ decision: 'known_key', knownKey: 'location' })
    const [loc] = await resolve('resolve.mapping', field('Where are you?', 'combobox'))
    expect(loc).toMatchObject({ tier: 'needs_input', value: null })
    expect(loc!.city).toBeUndefined()
  })
})
