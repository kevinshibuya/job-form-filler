import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { ACCOMMODATION_REASON, type EnumField, type HostRequest, type HostResponse, type Resolution } from '@jff/shared'
import { openDb, setProfile } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { CodexError } from '../llm/codexCli.js'
import { resolveModels } from '../llm/models.js'

// Seam 1 of spec #98: `resolve.mapping` through the host's request handler,
// with a real in-memory database and a fake Mapping runner. A Needs input
// Field whose label asks about accommodation needs comes back with the reason
// `accommodation`, whatever label Mapping gave it and when Mapping fails: the
// rule is on the wording, never the model's (ADR 0014).

type Entry = Record<string, unknown> & { ref: string }

let db: Database.Database
let deps: HandlerDeps
let reply: (ref: string) => Entry
const mapping = vi.fn()

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100' })
  reply = (ref) => ({ ref, decision: 'custom', knownKey: null, answerId: null, fieldClass: 'prose' })
  mapping.mockReset()
  mapping.mockImplementation(async (prompt: string) =>
    [...prompt.matchAll(/^- ref=(\S+)/gm)].map((m) => reply(m[1]!)))
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
const ADAPTACAO = field(3, 'Precisa de alguma adaptação no processo seletivo?', { kind: 'text' })
const VERSIONS = field(4, 'Which versions of TypeScript have you worked with?', { kind: 'text' })

async function mapped(fields: EnumField[]): Promise<{ resolutions: Resolution[]; llmError: { kind: string } | null }> {
  const r: HostResponse = await handleRequest(deps, {
    requestId: crypto.randomUUID(), method: 'resolve.mapping',
    params: {
      epoch: 4, url: 'https://jobs.example.com/apply', hostname: 'jobs.example.com',
      company: 'Example Co', jobText: 'Engineer wanted.', fields,
    },
  } as HostRequest)
  if (!r.ok) throw new Error(`resolve.mapping failed: ${r.error.kind} ${r.error.message}`)
  return r.result as { resolutions: Resolution[]; llmError: { kind: string } | null }
}

const byFid = (rs: Resolution[]) => new Map(rs.map((r) => [r.handle.fid, r]))

describe('A question about accommodation needs carries the reason accommodation', () => {
  it('when Mapping labels it prose', async () => {
    const r = byFid((await mapped([WHY, ACCOMMODATION, ADAPTACAO])).resolutions)
    expect(r.get(2)).toMatchObject({ tier: 'needs_input', value: null, key: null, reason: ACCOMMODATION_REASON })
    expect(r.get(3)).toMatchObject({ tier: 'needs_input', value: null, key: null, reason: ACCOMMODATION_REASON })
    expect(r.get(1)).toMatchObject({ tier: 'needs_input', reason: 'custom', fieldClass: 'prose' })
  })

  it('when Mapping labels it a personal fact', async () => {
    reply = (ref) => ({ ref, decision: 'custom', knownKey: null, answerId: null, fieldClass: 'personal_fact' })
    const r = byFid((await mapped([ACCOMMODATION, ADAPTACAO, VERSIONS])).resolutions)
    expect(r.get(2)).toMatchObject({ tier: 'needs_input', reason: ACCOMMODATION_REASON })
    expect(r.get(3)).toMatchObject({ tier: 'needs_input', reason: ACCOMMODATION_REASON })
    expect(r.get(4)).toMatchObject({ tier: 'needs_input', reason: 'custom', fieldClass: 'personal_fact' })
  })

  it('when Mapping fails', async () => {
    mapping.mockImplementation(async () => { throw new CodexError('rate_limit', 'usage limit reached') })
    const out = await mapped([WHY, ACCOMMODATION, ADAPTACAO])
    expect(out.llmError).toMatchObject({ kind: 'rate_limit' })
    const r = byFid(out.resolutions)
    expect(r.get(2)).toMatchObject({ tier: 'needs_input', reason: ACCOMMODATION_REASON })
    expect(r.get(3)).toMatchObject({ tier: 'needs_input', reason: ACCOMMODATION_REASON })
    expect(r.get(1)).toMatchObject({ tier: 'needs_input', reason: 'llm-error:rate_limit' })
  })

  it('when the Mapping reply leaves it out', async () => {
    mapping.mockImplementation(async () => [{ ref: '0:1', decision: 'custom', knownKey: null, answerId: null, fieldClass: 'prose' }])
    const r = byFid((await mapped([WHY, ACCOMMODATION])).resolutions)
    expect(r.get(2)).toMatchObject({ tier: 'needs_input', reason: ACCOMMODATION_REASON })
  })

  it('when Mapping points it at a Saved answer kept for another Company', async () => {
    reply = (ref) => ({ ref, decision: 'reuse_answer', knownKey: null, answerId: 9999, fieldClass: null })
    const r = byFid((await mapped([ACCOMMODATION])).resolutions)
    expect(r.get(2)).toMatchObject({ tier: 'needs_input', reason: ACCOMMODATION_REASON })
  })
})
