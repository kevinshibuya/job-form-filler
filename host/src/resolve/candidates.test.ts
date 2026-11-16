import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField, Resolution, WidgetKind } from '@jff/shared'
import { openDb, setAnswerBank, setProfile } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'

// Ticket #26: a Resolution carries the candidate words of its Value, by Known
// key. Every test sends a Resolution request through the host's request
// handler with a real in-memory database and a fake Mapping runner (spec #6,
// testing decision 2). The persona is Ada Lovelace; her country is not the
// maintainer's.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string }

let db: Database.Database
let deps: HandlerDeps
let decide: (ref: string) => Decision

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, {
    firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100',
    location: 'Berlin, Germany', city: 'Berlin', country: 'Germany',
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

describe('candidate words on a Resolution', () => {
  it("a Resolution for country carries the country's names in both languages", async () => {
    const [r] = await resolve('resolve.first', field('Country', 'combobox'))
    expect(r).toMatchObject({ tier: 'auto', key: 'country', value: 'Germany' })
    expect(r!.candidates).toEqual(expect.arrayContaining(['Germany', 'Alemanha']))
  })

  it('carries them on every Control country answers: a native select and a text box', async () => {
    const [select, text] = await resolve('resolve.first',
      field('País', 'select', { options: ['Selecione', 'Alemanha', 'Brasil'] }),
      field('Country of residence', 'text'))
    expect(select).toMatchObject({ key: 'country', value: 'Germany' })
    expect(select!.candidates).toContain('Alemanha')
    expect(text).toMatchObject({ key: 'country', value: 'Germany' })
    expect(text!.candidates).toContain('Alemanha')
  })

  it('a country Mapping proposes carries them too', async () => {
    const f = field('Where in the world are you?', 'select', { options: ['Germany', 'France'] })
    decide = () => ({ decision: 'known_key', knownKey: 'country' })
    const [r] = await resolve('resolve.mapping', f)
    expect(r).toMatchObject({ tier: 'proposed', source: 'llm_key', key: 'country', value: 'Germany' })
    expect(r!.candidates).toEqual(expect.arrayContaining(['Germany', 'Alemanha']))
  })

  it('a stored country outside the closed list carries none', async () => {
    setProfile(db, { country: 'Atlantis' })
    const [r] = await resolve('resolve.first', field('Country', 'combobox'))
    expect(r).toMatchObject({ key: 'country', value: 'Atlantis' })
    expect(r!.candidates ?? []).toEqual([])
  })

  it('a Resolution for a text key carries none', async () => {
    const [email, city, location] = await resolve('resolve.first',
      field('Email', 'text'), field('City', 'text'), field('Location', 'text'))
    expect(email).toMatchObject({ key: 'email', value: 'ada@example.com' })
    expect(city).toMatchObject({ key: 'city', value: 'Berlin' })
    expect(location).toMatchObject({ key: 'location' })
    for (const r of [email, city, location]) expect(r!.candidates ?? []).toEqual([])
  })

  it('the old free text of work authorization and sponsorship carries none', async () => {
    setAnswerBank(db, { workAuth: 'yes', sponsorshipNeeded: 'no' })
    const rows = await resolve('resolve.first',
      field('Are you legally authorized to work here?', 'text'),
      field('Will you require visa sponsorship?', 'text'))
    expect(rows.map((r) => r!.key)).toEqual(['workAuth', 'sponsorshipNeeded'])
    for (const r of rows) expect(r!.candidates ?? []).toEqual([])
  })

  it('a value already on the page under country carries none: only a stored Known key Value does', async () => {
    setProfile(db, { country: '' })
    const [r] = await resolve('resolve.first', field('Country', 'combobox', { currentValue: 'Germany' }))
    expect(r).toMatchObject({ source: 'page', key: 'country' })
    expect(r!.candidates ?? []).toEqual([])
  })
})
