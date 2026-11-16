import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EnumField, Resolution, WidgetKind } from '@jff/shared'
import type Database from 'better-sqlite3'
import { openDb, setProfile } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'

// Ticket #30: the Resolution of a phone Field carries, beside the international
// form, the calling code, the national number and the names of the phone's
// country, so a Fill can set the country selector beside the phone box. Every
// test goes through the host's request handler with a real in-memory database
// and a fake Mapping runner (spec #6, testing decision 2). The persona is Ada
// Lovelace; her country is not the maintainer's.

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

describe('the Resolution of a phone Field carries the parts of the phone', () => {
  it('a phone of +15550100 with a stored country of United States: calling code 1, national number 5550100, the names of the United States', async () => {
    const [phone] = await resolve('resolve.first', field('Phone'))
    expect(phone).toMatchObject({ tier: 'auto', key: 'phone', value: '+15550100' })
    expect(phone!.phone).toMatchObject({ callingCode: '1', nationalNumber: '5550100' })
    expect(phone!.phone!.countryNames).toEqual(expect.arrayContaining(['United States', 'USA', 'Estados Unidos']))
    expect(phone!.phone!.countryNames).not.toContain('Canada')
  })

  it('the same phone with a stored country of Canada carries the names of Canada', async () => {
    setProfile(db, { country: 'Canada' })
    const [phone] = await resolve('resolve.first', field('Phone'))
    expect(phone!.phone).toMatchObject({ callingCode: '1', nationalNumber: '5550100' })
    expect(phone!.phone!.countryNames).toEqual(expect.arrayContaining(['Canada', 'Canadá']))
    expect(phone!.phone!.countryNames).not.toContain('United States')
  })

  it('a stored country whose calling code is not the phone\'s, and a code several countries share: no country', async () => {
    setProfile(db, { country: 'Portugal' })
    const [phone] = await resolve('resolve.first', field('Phone'))
    expect(phone!.phone).toEqual({ callingCode: '1', nationalNumber: '5550100', countryNames: [] })
  })

  it('a stored country whose calling code is not the phone\'s, and a code one country has: that country', async () => {
    setProfile(db, { phone: '+351210000000', country: 'United States' })
    const [phone] = await resolve('resolve.first', field('Phone'))
    expect(phone!.phone).toMatchObject({ callingCode: '351', nationalNumber: '210000000' })
    expect(phone!.phone!.countryNames).toContain('Portugal')
  })

  it('a phone Field Mapping answers carries the parts too', async () => {
    decide = () => ({ decision: 'known_key', knownKey: 'phone' })
    const [phone] = await resolve('resolve.mapping', field('How can we reach you?'))
    expect(phone).toMatchObject({ key: 'phone', value: '+15550100' })
    expect(phone!.phone).toMatchObject({ callingCode: '1', nationalNumber: '5550100' })
  })

  it('a phone whose calling code is outside the closed list carries no parts, and keeps its international form', async () => {
    setProfile(db, { phone: '+2135550100' })
    const [phone] = await resolve('resolve.first', field('Phone'))
    expect(phone).toMatchObject({ key: 'phone', value: '+2135550100' })
    expect(phone!.phone).toBeUndefined()
  })

  it('no other Resolution carries phone parts', async () => {
    const [email, country] = await resolve('resolve.first', field('Email'), field('Country', 'select', { options: ['United States', 'Canada'] }))
    expect(email!.phone).toBeUndefined()
    expect(country!.phone).toBeUndefined()
  })
})
