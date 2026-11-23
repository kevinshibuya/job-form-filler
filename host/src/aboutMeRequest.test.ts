import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { ABOUT_ME_MAX, FIELD_KEYS, isFieldKey, type EnumField, type HostRequest, type HostResponse, type Resolution } from '@jff/shared'
import { MIGRATIONS } from './db/migrations.js'
import { openDb, setProfile } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'

// Seam 1 of spec #98, ticket #106: About me through the host's request
// handler, with a real database and fake model runners. What is asserted is
// what each request answers and what each model is shown.

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

const ABOUT_ME = 'I can be on site in London two days a week. I prefer TypeScript and Postgres.'

let db: Database.Database
let deps: HandlerDeps
let writerPrompts: string[]
let checkPrompts: string[]
let mappingPrompts: string[]

const writer = vi.fn()
const codex = vi.fn()

const DRAFT = 'Yes, I can be on site two days a week.'
const isMappingPrompt = (prompt: string): boolean => /fieldClass="personal_fact"/.test(prompt)

function depsFor(database: Database.Database): HandlerDeps {
  return {
    db: database,
    runner: { complete: writer } as unknown as HandlerDeps['runner'],
    codex: { complete: codex } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
}

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100' })
  writerPrompts = []
  checkPrompts = []
  mappingPrompts = []
  writer.mockReset()
  writer.mockImplementation(async (prompt: string) => { writerPrompts.push(prompt); return { draft: DRAFT } })
  codex.mockReset()
  codex.mockImplementation(async (prompt: string) => {
    if (isMappingPrompt(prompt)) {
      mappingPrompts.push(prompt)
      return [...prompt.matchAll(/^- ref=(\S+)/gm)].map((m) => ({ ref: m[1]!, decision: 'custom', knownKey: null, answerId: null, fieldClass: 'personal_fact' }))
    }
    checkPrompts.push(prompt)
    return { draft: DRAFT, unsupported: [] }
  })
  deps = depsFor(db)
})

async function call(method: HostRequest['method'], params: unknown, on: HandlerDeps = deps): Promise<HostResponse> {
  return await handleRaw(on, { requestId: crypto.randomUUID(), method, params })
}

async function stored(on: HandlerDeps = deps): Promise<string> {
  const r = await call('aboutMe.get', {}, on)
  if (!r.ok) throw new Error(`aboutMe.get failed: ${r.error.message}`)
  return (r.result as { text: string }).text
}

async function generate(questionRaw = 'Could you work from our office twice a week?'): Promise<void> {
  const r = await call('generate', {
    handle: { frameId: 0, fid: 9, epoch: 1 }, questionRaw, jobText: 'Acme builds payment rails.', company: 'Acme', fieldClass: 'personal_fact',
  })
  expect(r).toMatchObject({ ok: true })
}

const HEADER = 'ABOUT ME'

describe('aboutMe.get and aboutMe.set', () => {
  it('answer an empty text on a new database', async () => {
    expect(await stored()).toBe('')
  })

  it('answer the text aboutMe.set stored, and a later set replaces it', async () => {
    expect(await call('aboutMe.set', { text: ABOUT_ME })).toMatchObject({ ok: true, result: { text: ABOUT_ME } })
    expect(await stored()).toBe(ABOUT_ME)
    await call('aboutMe.set', { text: 'I prefer Rust.' })
    expect(await stored()).toBe('I prefer Rust.')
  })

  it('store an empty text as no About me', async () => {
    await call('aboutMe.set', { text: ABOUT_ME })
    expect(await call('aboutMe.set', { text: '' })).toMatchObject({ ok: true, result: { text: '' } })
    expect(await stored()).toBe('')
  })

  it('take a text of exactly the cap', async () => {
    const full = 'a'.repeat(ABOUT_ME_MAX)
    expect(await call('aboutMe.set', { text: full })).toMatchObject({ ok: true })
    expect(await stored()).toBe(full)
  })

  it('refuse a text over 4,000 characters with a message that names the cap, and store nothing', async () => {
    expect(ABOUT_ME_MAX).toBe(4000)
    await call('aboutMe.set', { text: ABOUT_ME })
    const r = await call('aboutMe.set', { text: 'a'.repeat(ABOUT_ME_MAX + 1) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('bad_request')
    expect(r.error.message).toContain('4,000')
    expect(await stored()).toBe(ABOUT_ME)
  })
})

describe('A database made before About me', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('opens, migrates, keeps its rows and answers an empty About me', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jff-about-me-'))
    const path = join(dir, 'db.sqlite')
    // The shape the Native host left before ticket #106: every migration
    // before About me's, with a Profile in it.
    const before = openDb(path, MIGRATIONS.slice(0, MIGRATIONS.findIndex((m) => /about me/i.test(m.name))))
    setProfile(before, { fullName: 'Ada Lovelace', email: 'ada@example.com' })
    before.close()

    const after = openDb(path)
    try {
      expect(after.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
      const on = depsFor(after)
      expect(await stored(on)).toBe('')
      expect(await call('profile.get', {}, on)).toMatchObject({ ok: true, result: { fullName: 'Ada Lovelace', email: 'ada@example.com' } })
      await call('aboutMe.set', { text: ABOUT_ME }, on)
      expect(await stored(on)).toBe(ABOUT_ME)
    } finally {
      after.close()
    }
  })
})

describe('A generate request hands the writer and the Draft check About me', () => {
  it('as a trusted block holding the stored text', async () => {
    await call('aboutMe.set', { text: ABOUT_ME })
    await generate()
    for (const prompt of [writerPrompts[0]!, checkPrompts[0]!]) {
      const lines = prompt.split('\n')
      const at = lines.findIndex((l) => l.startsWith(`${HEADER} (`))
      expect(at).toBeGreaterThanOrEqual(0)
      expect(lines[at]).toMatch(/trusted/i)
      // The user's own text, whole and unfenced, on the line under its header.
      expect(lines[at + 1]).toBe(ABOUT_ME)
    }
  })

  it('and no such block when it is empty', async () => {
    await generate()
    await call('aboutMe.set', { text: '   \n ' })
    await generate()
    for (const prompt of [...writerPrompts, ...checkPrompts]) expect(prompt).not.toContain(`${HEADER} (`)
  })

  it('names About me among the blocks a factual claim may rest on, for both kinds of Field and the Draft check', async () => {
    await generate()
    await call('generate', {
      handle: { frameId: 0, fid: 10, epoch: 1 }, questionRaw: 'Why do you want to work here?', jobText: 'Acme builds payment rails.', company: 'Acme', fieldClass: 'prose',
    })
    const claimRule = (prompt: string): string => prompt.split('\n').find((l) => /may come ONLY from/.test(l)) ?? ''
    expect(claimRule(writerPrompts[0]!)).toContain(HEADER)
    expect(claimRule(writerPrompts[1]!)).toContain(HEADER)
    const trusted = (prompt: string): string => prompt.split('\n').find((l) => l.startsWith('The trusted blocks are')) ?? ''
    for (const prompt of checkPrompts) expect(trusted(prompt)).toContain(HEADER)
  })
})

describe('About me is not a Known key', () => {
  const field = (fid: number, label: string): EnumField => ({
    frameId: 0, fid, epoch: 4, label, name: null, idAttr: null, kind: 'textarea',
    options: [], required: false, visible: true, currentValue: null, demographic: false,
  })
  const scan = (fields: EnumField[]) => ({
    epoch: 4, url: 'https://jobs.example.com/apply', hostname: 'jobs.example.com', company: 'Example Co', jobText: 'Engineer wanted.', fields,
  })

  it('is not among the Known keys', () => {
    expect(FIELD_KEYS.some((k) => /about/i.test(k))).toBe(false)
    expect(isFieldKey('aboutMe')).toBe(false)
  })

  it('never reaches Mapping, and no Resolution carries it as a Value', async () => {
    await call('aboutMe.set', { text: ABOUT_ME })
    const fields = [field(1, 'Tell us about yourself'), field(2, 'About me'), field(3, 'Which tools do you prefer?')]
    const first = await call('resolve.first', scan(fields))
    const mapping = await call('resolve.mapping', scan(fields))
    expect(mappingPrompts.length).toBeGreaterThan(0)
    for (const prompt of mappingPrompts) {
      expect(prompt).not.toContain(ABOUT_ME)
      expect(prompt).not.toContain('ABOUT ME')
    }
    for (const r of [first, mapping]) {
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      for (const res of (r.result as { resolutions: Resolution[] }).resolutions) {
        expect(res.value ?? '').not.toContain('on site in London')
      }
    }
  })
})
