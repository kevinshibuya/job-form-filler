import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { EnumField, FieldHandle, HostRequest, HostResponse, Resolution } from '@jff/shared'
import { openDb, setProfile, setAnswerBank, upsertAnswer } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { CodexError } from '../llm/codexCli.js'
import { resolveModels } from '../llm/models.js'

// Seam 2 of spec #5: requests go through the host's request handler with a real
// in-memory database and fake model runners. Both runners count their calls, so
// "runs no model" is asserted on a count, not on a thrown error the host would
// have turned into an llmError anyway.

type MappingEntry = { ref: string; decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey: string | null; answerId: number | null }

const claudeComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => ({ draft: 'x' }))
const codexComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => [] as MappingEntry[])

let db: Database.Database
let deps: HandlerDeps

const modelCalls = () => claudeComplete.mock.calls.length + codexComplete.mock.calls.length

const field = (fid: number, label: string, extra: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid, epoch: 5, label, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...extra,
})

const handleOf = (f: EnumField): FieldHandle => ({ frameId: f.frameId, fid: f.fid, epoch: f.epoch })

const params = (fields: EnumField[]) => ({
  epoch: 5, url: 'https://boards.greenhouse.io/acme/jobs/1',
  hostname: 'boards.greenhouse.io', company: 'Acme', jobText: 'Senior engineer wanted.', fields,
})

type FirstResult = { epoch: number; resolutions: Resolution[]; pending: FieldHandle[] }
type MappingResult = { epoch: number; resolutions: Resolution[]; llmError: { kind: string; message: string } | null }

async function send<T>(method: 'resolve' | 'resolve.first' | 'resolve.mapping', fields: EnumField[], requestId: string = crypto.randomUUID()): Promise<T> {
  const r: HostResponse = await handleRequest(deps, { requestId, method, params: params(fields) } as HostRequest)
  if (!r.ok) throw new Error(`${method} failed: ${r.error.kind} ${r.error.message}`)
  return r.result as T
}

const mappingReplies = (entries: MappingEntry[]) => codexComplete.mockImplementation(async () => entries)

beforeEach(() => {
  db = openDb(':memory:')
  claudeComplete.mockClear()
  codexComplete.mockReset()
  codexComplete.mockImplementation(async () => [])
  setProfile(db, {
    firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+1 555 0100',
    linkedin: 'https://linkedin.com/in/ada', github: 'https://github.com/ada',
  })
  setAnswerBank(db, { salary: 'USD 100k' })
  deps = {
    db,
    runner: { complete: claudeComplete } as unknown as HandlerDeps['runner'],
    codex: { complete: codexComplete } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

// A Scan with a Field of every kind the first step decides, plus two it cannot.
const scan = () => [
  field(1, 'First Name'),
  field(2, 'Last Name'),
  field(3, 'E-mail'),
  field(4, 'Phone'),
  field(5, 'LinkedIn Profile'),
  field(6, 'GitHub'),
  field(7, 'How many years of React do you have?'),
  field(8, 'Gender', { demographic: true }),
  field(9, 'City', { currentValue: 'London' }),
  field(10, 'I agree to the privacy policy', { kind: 'checkbox' }),
  field(11, 'Portfolio URL'),
  field(12, 'What are your comp expectations for this role?'),
  field(13, 'Tell us about a hard technical decision.'),
]

describe('resolve.first', () => {
  beforeEach(() => {
    upsertAnswer(db, {
      questionNormalized: 'how many years of react do you have', questionRaw: 'How many years of React do you have?',
      answer: '6 years', language: 'en', reusability: 'reusable',
    })
  })

  it('makes zero calls to any model runner for a request that has pending Fields', async () => {
    const r = await send<FirstResult>('resolve.first', scan())
    expect(r.pending.length).toBeGreaterThan(0)
    expect(modelCalls()).toBe(0)
  })

  it('returns the stored name, email, phone and links, and exact Saved answer matches, as auto-fill', async () => {
    const r = await send<FirstResult>('resolve.first', scan())
    const byFid = new Map(r.resolutions.map((x) => [x.handle.fid, x]))
    expect(byFid.get(1)).toMatchObject({ tier: 'auto', source: 'profile', key: 'firstName', value: 'Ada' })
    expect(byFid.get(2)).toMatchObject({ tier: 'auto', source: 'profile', key: 'lastName', value: 'Lovelace' })
    expect(byFid.get(3)).toMatchObject({ tier: 'auto', source: 'profile', key: 'email', value: 'ada@example.com' })
    expect(byFid.get(4)).toMatchObject({ tier: 'auto', source: 'profile', key: 'phone', value: '+1 555 0100' })
    expect(byFid.get(5)).toMatchObject({ tier: 'auto', source: 'profile', key: 'linkedin', value: 'https://linkedin.com/in/ada' })
    expect(byFid.get(6)).toMatchObject({ tier: 'auto', source: 'profile', key: 'github', value: 'https://github.com/ada' })
    expect(byFid.get(7)).toMatchObject({ tier: 'auto', source: 'saved_answer', value: '6 years', reason: 'exact-match' })
  })

  it('decides Skipped, already on page, Consent checkbox and a Known key with nothing stored', async () => {
    const r = await send<FirstResult>('resolve.first', scan())
    const byFid = new Map(r.resolutions.map((x) => [x.handle.fid, x]))
    expect(byFid.get(8)).toMatchObject({ tier: 'skipped', reason: 'eeo' })
    expect(byFid.get(9)).toMatchObject({ tier: 'auto', source: 'page', value: 'London' })
    expect(byFid.get(10)).toMatchObject({ tier: 'needs_input', reason: 'consent-checkbox' })
    expect(byFid.get(11)).toMatchObject({ tier: 'needs_input', key: 'portfolio', reason: 'recognizer:portfolio:no-stored-value' })
  })

  it('puts every Field in resolutions or in pending, never both and never neither', async () => {
    const fields = scan()
    const r = await send<FirstResult>('resolve.first', fields)
    const decided = r.resolutions.map((x) => x.handle.fid)
    const pending = r.pending.map((h) => h.fid)
    expect(decided.filter((fid) => pending.includes(fid))).toEqual([])
    expect([...decided, ...pending].sort((a, b) => a - b)).toEqual(fields.map((f) => f.fid))
    expect(pending).toEqual([12, 13])
    expect(r.pending).toEqual([handleOf(fields[11]!), handleOf(fields[12]!)])
    expect(r.epoch).toBe(5)
  })
})

describe('resolve.mapping', () => {
  it('returns for the pending Fields the Resolutions resolve gives them', async () => {
    const reuseId = upsertAnswer(db, {
      questionNormalized: 'years of react', questionRaw: 'Years of React?', answer: '6 years', language: 'en', reusability: 'reusable',
    })
    const pending = [
      field(1, 'What are your comp expectations for this role?'),
      field(2, 'React experience in years?'),
      field(3, 'Tell us about a hard technical decision.'),
    ]
    mappingReplies([
      { ref: '0:1', decision: 'known_key', knownKey: 'salary', answerId: null },
      { ref: '0:2', decision: 'reuse_answer', knownKey: null, answerId: reuseId },
      { ref: '0:3', decision: 'custom', knownKey: null, answerId: null },
    ])

    const mapped = await send<MappingResult>('resolve.mapping', pending)
    expect(mapped.resolutions).toHaveLength(3)
    expect(mapped.resolutions[0]).toMatchObject({ handle: handleOf(pending[0]!), tier: 'proposed', source: 'llm_key', key: 'salary', value: 'USD 100k' })
    expect(mapped.resolutions[1]).toMatchObject({ handle: handleOf(pending[1]!), tier: 'proposed', source: 'llm_reuse', value: '6 years', answerId: reuseId })
    expect(mapped.resolutions[2]).toMatchObject({ handle: handleOf(pending[2]!), tier: 'needs_input', value: null, reason: 'custom' })
    expect(mapped.llmError).toBeNull()

    const whole = await send<MappingResult>('resolve', pending)
    expect(mapped).toEqual(whole)
  })

  it('answers on a host that never served a resolve.first', async () => {
    // A fresh database stands in for a restarted host: no request log, nothing
    // remembered from any earlier step.
    mappingReplies([{ ref: '0:1', decision: 'known_key', knownKey: 'salary', answerId: null }])
    const r = await send<MappingResult>('resolve.mapping', [field(1, 'What are your comp expectations for this role?')])
    expect(r.resolutions).toEqual([expect.objectContaining({ tier: 'proposed', key: 'salary', value: 'USD 100k' })])
    expect(codexComplete).toHaveBeenCalledTimes(1)
  })

  it('returns every Field as Needs input with the error when Mapping fails', async () => {
    codexComplete.mockImplementation(async () => { throw new CodexError('rate_limit', 'limit') })
    const fields = [field(1, 'Anything else?'), field(2, 'What should we know about you?')]
    const r = await send<MappingResult>('resolve.mapping', fields)
    expect(r.llmError).toEqual({ kind: 'rate_limit', message: 'limit' })
    expect(r.resolutions.map((x) => x.handle.fid)).toEqual([1, 2])
    expect(r.resolutions.every((x) => x.tier === 'needs_input' && x.reason === 'llm-error:rate_limit')).toBe(true)
  })

  it('returns no Resolutions and calls no model when given no Fields', async () => {
    const r = await send<MappingResult>('resolve.mapping', [])
    expect(r).toEqual({ epoch: 5, resolutions: [], llmError: null })
    expect(modelCalls()).toBe(0)
  })

  it('never sends a Demographic Field to the model, even when the panel sends it', async () => {
    const r = await send<MappingResult>('resolve.mapping', [field(1, 'Gender', { demographic: true })])
    expect(r.resolutions[0]).toMatchObject({ tier: 'skipped', reason: 'eeo' })
    expect(modelCalls()).toBe(0)
  })
})

describe('the replay log and the two requests of one Scan', () => {
  it('replays a repeated request id with its own stored reply', async () => {
    const fields = scan()
    const first = await send<FirstResult>('resolve.first', fields, 'scan-1-first')
    setProfile(db, { email: 'changed@example.com' })
    const again = await send<FirstResult>('resolve.first', fields, 'scan-1-first')
    expect(again).toEqual(first)

    mappingReplies([{ ref: '0:12', decision: 'known_key', knownKey: 'salary', answerId: null }])
    const pending = fields.filter((f) => first.pending.some((h) => h.fid === f.fid))
    const mapped = await send<MappingResult>('resolve.mapping', pending, 'scan-1-mapping')
    const mappedAgain = await send<MappingResult>('resolve.mapping', pending, 'scan-1-mapping')
    expect(mappedAgain).toEqual(mapped)
    expect(codexComplete).toHaveBeenCalledTimes(1)
  })

  it('does not let the two requests of one Scan replay each other', async () => {
    const fields = scan()
    const first = await send<FirstResult>('resolve.first', fields, 'scan-2-first')
    mappingReplies([{ ref: '0:12', decision: 'known_key', knownKey: 'salary', answerId: null }])
    const pending = fields.filter((f) => first.pending.some((h) => h.fid === f.fid))
    const mapped = await send<MappingResult>('resolve.mapping', pending, 'scan-2-mapping')

    expect(mapped).toHaveProperty('llmError', null)
    expect(mapped).not.toHaveProperty('pending')
    expect(mapped.resolutions.map((x) => x.handle)).toEqual(first.pending)
    expect(codexComplete).toHaveBeenCalledTimes(1)
  })
})

describe('resolve runs the two steps one after the other', () => {
  it('returns the first step’s Resolutions and Mapping’s, in Field order', async () => {
    upsertAnswer(db, {
      questionNormalized: 'how many years of react do you have', questionRaw: 'How many years of React do you have?',
      answer: '6 years', language: 'en', reusability: 'reusable',
    })
    mappingReplies([
      { ref: '0:12', decision: 'known_key', knownKey: 'salary', answerId: null },
      { ref: '0:13', decision: 'custom', knownKey: null, answerId: null },
    ])
    const fields = scan()
    const whole = await send<MappingResult>('resolve', fields)

    const first = await send<FirstResult>('resolve.first', fields)
    const pending = fields.filter((f) => first.pending.some((h) => h.fid === f.fid))
    const mapped = await send<MappingResult>('resolve.mapping', pending)

    const byFid = new Map([...first.resolutions, ...mapped.resolutions].map((x) => [x.handle.fid, x]))
    expect(whole.resolutions).toEqual(fields.map((f) => byFid.get(f.fid)))
    expect(whole.llmError).toEqual(mapped.llmError)
    expect(whole.epoch).toBe(5)
  })
})
