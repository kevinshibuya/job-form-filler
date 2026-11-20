import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { ApplyAddressPickParams, HostRequest, HostResponse } from '@jff/shared'
import { openDb, setProfile } from './db/repos.js'
import { handleRaw, handleRequest, type HandlerDeps } from './handlers.js'
import { CodexError } from './llm/codexCli.js'
import { resolveModels } from './llm/models.js'

// Ticket #71 at the Native host's request seam: `applyAddress.pick` goes
// through the request handler with a real in-memory database and fake model
// runners. What is asserted is what the request answers and what the model
// was shown.

const claudeComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => ({ draft: 'x' }))
const codexComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => ({ position: null }))

let db: Database.Database
let deps: HandlerDeps

const CONFIG: HandlerDeps['config'] = {
  claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json',
  capturesDir: '/nonexistent/jff-captures', privateStringsPath: '/nonexistent/jff-private-strings.txt', models: {},
}

beforeEach(() => {
  db = openDb(':memory:')
  claudeComplete.mockClear()
  codexComplete.mockReset()
  codexComplete.mockImplementation(async () => ({ position: null }))
  setProfile(db, { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+15550100', city: 'Paris' })
  deps = {
    db,
    runner: { complete: claudeComplete } as unknown as HandlerDeps['runner'],
    codex: { complete: codexComplete } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: CONFIG,
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

/** A careers page: a footer address for privacy, and the address the posting names for applications. */
const CAREERS: ApplyAddressPickParams = {
  candidates: [
    { address: 'privacy@example.org', contexts: [{ kind: 'text', sentence: 'For privacy questions write to privacy@example.org.' }] },
    {
      address: 'jobs@example.org',
      contexts: [
        { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' },
        { kind: 'text', sentence: 'Send your CV to jobs@example.org.' },
      ],
    },
  ],
  title: 'Analyst at Acme',
  company: 'Acme',
  jobText: 'Acme is hiring an analyst. Send your CV to jobs@example.org.',
}

/** As the request arrives on stdin: checked against the schema, then handled. */
async function pick(params: unknown): Promise<HostResponse> {
  return handleRaw(deps, { requestId: crypto.randomUUID(), method: 'applyAddress.pick', params })
}

const promptSent = (): string => codexComplete.mock.calls[0]![0]

describe('applyAddress.pick', () => {
  it('answers with the position of the candidate the model pointed at, and no address in any field', async () => {
    codexComplete.mockImplementation(async () => ({ position: 1, address: 'jobs@example.org', text: 'jobs@example.org' }))
    const r = await pick(CAREERS)
    if (!r.ok) throw new Error('failed')
    expect(r.result).toEqual({ position: 1 })
    expect(JSON.stringify(r)).not.toContain('@')
  })

  it('answers none when the model says none', async () => {
    const r = await pick(CAREERS)
    if (!r.ok) throw new Error('failed')
    expect(r.result).toEqual({ position: null })
  })

  it.each([
    ['a position past the last candidate', { position: 2 }],
    ['a negative position', { position: -1 }],
    ['an address instead of a position', { position: 'jobs@example.org' }],
    ['an address beside no position', { address: 'careers@example.org' }],
    ['a fraction', { position: 0.5 }],
    ['written text', 'jobs@example.org'],
  ])('refuses %s and answers none', async (_what, reply) => {
    codexComplete.mockImplementation(async () => reply)
    const r = await pick(CAREERS)
    if (!r.ok) throw new Error('failed')
    expect(r.result).toEqual({ position: null })
  })

  it('shows the model the candidates, their contexts, the title, the Company and the job text, fenced, and nothing from the Profile', async () => {
    await pick(CAREERS)
    const prompt = promptSent()
    expect(prompt).toContain('<address>privacy@example.org</address>')
    expect(prompt).toContain('<address>jobs@example.org</address>')
    expect(prompt).toContain('<address_context>Apply by email</address_context>')
    expect(prompt).toContain('<address_context>Application: Analyst</address_context>')
    expect(prompt).toContain('<job_title>Analyst at Acme</job_title>')
    expect(prompt).toContain('<company>Acme</company>')
    expect(prompt).toContain('<job_post>Acme is hiring an analyst. Send your CV to jobs@example.org.</job_post>')
    for (const other of ['Ada', 'Lovelace', 'ada@example.com', '5550100', 'Paris']) expect(prompt).not.toContain(other)
  })

  it('runs on claude-opus-5-5 by default, through the structured-task runner', async () => {
    await pick(CAREERS)
    expect(codexComplete).toHaveBeenCalledTimes(1)
    expect(codexComplete.mock.calls[0]![2]).toMatchObject({ model: 'claude-opus-5-5' })
    expect(claudeComplete).not.toHaveBeenCalled()
  })

  it('runs on the model the config overrides it with', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jff-pick-config-'))
    try {
      writeFileSync(join(home, 'config.json'), JSON.stringify({ models: { applyAddressPick: 'gpt-6-astra' } }), 'utf8')
      vi.resetModules()
      process.env.JFF_HOME = home
      const { loadConfig } = await import('./config.js')
      const config = await loadConfig()
      deps = { ...deps, config, models: resolveModels(config.models) }
    } finally {
      delete process.env.JFF_HOME
      rmSync(home, { recursive: true, force: true })
    }
    await pick(CAREERS)
    expect(codexComplete.mock.calls[0]![2]).toMatchObject({ model: 'gpt-6-astra' })
  })

  it('refuses a request with no candidate and asks no model', async () => {
    const r = await pick({ ...CAREERS, candidates: [] })
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect(codexComplete).not.toHaveBeenCalled()
  })

  it('a model call that fails answers an error the panel can name', async () => {
    codexComplete.mockImplementation(async () => { throw new CodexError('timeout', 'codex timed out') })
    const r = await pick(CAREERS)
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } })
  })

  it('a failed pick is not replayed: the same request asks the model again', async () => {
    codexComplete.mockImplementationOnce(async () => { throw new CodexError('rate_limit', 'slow down') })
    const req = { requestId: crypto.randomUUID(), method: 'applyAddress.pick', params: CAREERS } as HostRequest
    expect((await handleRequest(deps, req)).ok).toBe(false)
    codexComplete.mockImplementation(async () => ({ position: 1 }))
    expect(await handleRequest(deps, req)).toMatchObject({ ok: true, result: { position: 1 } })
  })
})
