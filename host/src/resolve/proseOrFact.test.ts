import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField, HostRequest, HostResponse, Resolution } from '@jff/shared'
import { openDb, setProfile, upsertAnswer } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { ClaudeError } from '../llm/claudeCli.js'
import { CodexError } from '../llm/codexCli.js'
import { resolveModels } from '../llm/models.js'
import { normalizeQuestion } from './normalize.js'

// Seam 2 of spec #5: the Resolution requests go through the host's request
// handler with a real in-memory database and a fake Mapping runner. What is
// asserted is what the panel receives: whether a Field Mapping matched to
// nothing is a Prose Field, which Generation may draft, or a Personal-fact
// Field, which the user answers.

type Entry = Record<string, unknown> & { ref: string }

let db: Database.Database
let deps: HandlerDeps
let prompts: string[]
/** What the fake Mapping replies for one ref of the prompt. */
let reply: (ref: string) => Entry
const mapping = vi.fn()

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100' })
  prompts = []
  reply = (ref) => ({ ref, decision: 'custom', knownKey: null, answerId: null, fieldClass: 'prose' })
  mapping.mockReset()
  mapping.mockImplementation(async (prompt: string) => {
    prompts.push(prompt)
    return [...prompt.matchAll(/^- ref=(\S+)/gm)].map((m) => reply(m[1]!))
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

const field = (fid: number, label: string, extra: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid, epoch: 4, label, name: null, idAttr: null, kind: 'textarea',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...extra,
})

const WHY = field(1, 'Why do you want this role?')
const ACCOMMODATION = field(2, 'Do you need any accommodation during the interview process?')
const WORKED_HERE = field(3, 'Have you worked at this company before?', { kind: 'text' })

async function request<T>(method: HostRequest['method'], params: unknown): Promise<T> {
  const r: HostResponse = await handleRequest(deps, { requestId: crypto.randomUUID(), method, params } as HostRequest)
  if (!r.ok) throw new Error(`${method} failed: ${r.error.kind} ${r.error.message}`)
  return r.result as T
}

const scanParams = (fields: EnumField[]) => ({
  epoch: 4, url: 'https://jobs.example.com/apply', hostname: 'jobs.example.com',
  company: 'Example Co', jobText: 'Engineer wanted.', fields,
})

type MappingResult = { resolutions: Resolution[]; llmError: { kind: string } | null }
const mapped = (fields: EnumField[]) => request<MappingResult>('resolve.mapping', scanParams(fields))
const first = (fields: EnumField[]) =>
  request<{ resolutions: Resolution[]; pending: unknown[] }>('resolve.first', scanParams(fields))

const byFid = (rs: Resolution[]) => new Map(rs.map((r) => [r.handle.fid, r]))

describe('Mapping labels every Field it matches to nothing', () => {
  it('comes back as a Prose Field or a Personal-fact Field, as Mapping said', async () => {
    reply = (ref) => ({
      ref, decision: 'custom', knownKey: null, answerId: null,
      fieldClass: ref === '0:1' ? 'prose' : 'personal_fact',
    })
    const r = byFid((await mapped([WHY, ACCOMMODATION, WORKED_HERE])).resolutions)
    expect(r.get(1)).toMatchObject({ tier: 'needs_input', value: null, fieldClass: 'prose' })
    expect(r.get(2)).toMatchObject({ tier: 'needs_input', value: null, fieldClass: 'personal_fact' })
    expect(r.get(3)).toMatchObject({ tier: 'needs_input', value: null, fieldClass: 'personal_fact' })
  })

  it('tells Mapping what each label means, with accommodation needs and past work at the Company as personal facts', async () => {
    await mapped([WHY])
    const prompt = prompts[0]!
    expect(prompt).toMatch(/fieldClass="prose"/)
    expect(prompt).toMatch(/fieldClass="personal_fact"/)
    expect(prompt).toMatch(/accommodation/i)
    expect(prompt).toMatch(/worked at the company/i)
  })

  it('leaves no label on a Field matched to a Known key or a Saved answer, whatever Mapping sent', async () => {
    const saved = upsertAnswer(db, {
      questionNormalized: normalizeQuestion('Tell us about a project you led'), questionRaw: 'Tell us about a project you led',
      answer: 'I led the analytical engine notes.', language: 'en', reusability: 'reusable',
    })
    reply = (ref) => ref === '0:5'
      ? { ref, decision: 'known_key', knownKey: 'email', answerId: null, fieldClass: 'prose' }
      : { ref, decision: 'reuse_answer', knownKey: null, answerId: saved, fieldClass: 'personal_fact' }
    const r = byFid((await mapped([
      field(5, 'Where can we reach you?', { kind: 'text' }),
      field(6, 'A project you are proud of'),
    ])).resolutions)
    expect(r.get(5)).toMatchObject({ tier: 'proposed', key: 'email', value: 'ada@example.com' })
    expect(r.get(6)).toMatchObject({ tier: 'proposed', source: 'llm_reuse', answerId: saved })
    expect(r.get(5)).not.toHaveProperty('fieldClass')
    expect(r.get(6)).not.toHaveProperty('fieldClass')
  })

  it('gives no label to what the first step decides', async () => {
    const r = await first([field(7, 'Email', { kind: 'text' }), field(8, 'I agree to the terms', { kind: 'checkbox' })])
    for (const res of r.resolutions) expect(res).not.toHaveProperty('fieldClass')
  })
})

describe('Erring toward asking', () => {
  it('makes a Field whose label is outside the two values, or missing, a Personal-fact Field', async () => {
    reply = (ref) => {
      if (ref === '0:1') return { ref, decision: 'custom', knownKey: null, answerId: null, fieldClass: 'essay' }
      if (ref === '0:2') return { ref, decision: 'custom', knownKey: null, answerId: null }
      return { ref, decision: 'custom', knownKey: null, answerId: null, fieldClass: 42 }
    }
    const out = await mapped([WHY, ACCOMMODATION, WORKED_HERE])
    // One bad label is that Field's problem, not the batch's.
    expect(out.llmError).toBeNull()
    for (const res of out.resolutions) expect(res).toMatchObject({ tier: 'needs_input', fieldClass: 'personal_fact' })
  })

  it('makes every Field of the request a Personal-fact Field when Mapping fails', async () => {
    mapping.mockImplementation(async () => { throw new CodexError('rate_limit', 'usage limit reached') })
    const out = await mapped([WHY, ACCOMMODATION])
    expect(out.llmError).toMatchObject({ kind: 'rate_limit' })
    expect(out.resolutions).toHaveLength(2)
    for (const res of out.resolutions) expect(res).toMatchObject({ tier: 'needs_input', fieldClass: 'personal_fact' })
  })

  it('keeps the kind of a Claude failure, so a Claude rate limit reads as a rate limit', async () => {
    mapping.mockImplementation(async () => { throw new ClaudeError('rate_limit', 'claude subscription rate limit reached') })
    const out = await mapped([WHY])
    expect(out.llmError).toEqual({ kind: 'rate_limit', message: 'claude subscription rate limit reached' })
  })

  it('does the same when the reply is unusable as a whole', async () => {
    mapping.mockImplementation(async () => [{ ref: '0:1', decision: 'custom', fieldClass: 'prose' }])
    const out = await mapped([WHY, ACCOMMODATION])
    for (const res of out.resolutions) expect(res).toMatchObject({ tier: 'needs_input', fieldClass: 'personal_fact' })
  })
})

describe('The Mapping reply carries no answer text', () => {
  it('drops text a reply tries to send, under any name', async () => {
    const claim = 'I have no accommodation needs.'
    reply = (ref) => ({
      ref, decision: 'custom', knownKey: null, answerId: null, fieldClass: 'personal_fact',
      value: claim, answer: claim, draft: claim, text: claim,
    })
    const out = await mapped([ACCOMMODATION])
    expect(out.resolutions[0]).toMatchObject({ tier: 'needs_input', value: null, fieldClass: 'personal_fact' })
    expect(JSON.stringify(out)).not.toContain(claim)
  })

  it('does not let the label itself carry text', async () => {
    const claim = 'I have no accommodation needs.'
    reply = (ref) => ({ ref, decision: 'custom', knownKey: null, answerId: null, fieldClass: claim })
    const out = await mapped([ACCOMMODATION])
    expect(out.resolutions[0]).toMatchObject({ fieldClass: 'personal_fact' })
    expect(JSON.stringify(out)).not.toContain(claim)
  })
})

describe('A Personal-fact answer is answered once', () => {
  it('is kept as a Saved answer on save, and the next Scan of the same question fills it', async () => {
    reply = (ref) => ({ ref, decision: 'custom', knownKey: null, answerId: null, fieldClass: 'personal_fact' })
    const before = await mapped([ACCOMMODATION])
    expect(before.resolutions[0]).toMatchObject({ tier: 'needs_input', fieldClass: 'personal_fact' })

    await request('save', {
      url: 'https://jobs.example.com/apply', company: 'Example Co', generatedCount: 0,
      items: [{
        handle: { frameId: 0, fid: 2, epoch: 4 }, questionRaw: ACCOMMODATION.label,
        answer: 'A quiet room, please.', reusability: 'reusable', fieldKey: null,
      }],
    })

    const next = await first([{ ...ACCOMMODATION, epoch: 5 }])
    expect(next.pending).toEqual([])
    expect(next.resolutions[0]).toMatchObject({ tier: 'auto', source: 'saved_answer', value: 'A quiet room, please.' })
  })
})
