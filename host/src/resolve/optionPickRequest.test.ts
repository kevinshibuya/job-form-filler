import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import type { HostRequest, HostResponse } from '@jff/shared'
import { openDb, setAnswerBank, setProfile } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { CodexError } from '../llm/codexCli.js'
import { resolveModels } from '../llm/models.js'

// Ticket #31 at seam 2 of spec #6: the `option.pick` request goes through the
// host's request handler with a real in-memory database and fake model
// runners. What is asserted is what the request answers and what the model
// was shown.

const claudeComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => ({ draft: 'x' }))
const codexComplete = vi.fn(async (_prompt: string, _schema?: unknown, _opts?: unknown): Promise<unknown> => ({ position: null }))

let db: Database.Database
let deps: HandlerDeps

beforeEach(() => {
  db = openDb(':memory:')
  claudeComplete.mockClear()
  codexComplete.mockReset()
  codexComplete.mockImplementation(async () => ({ position: null }))
  setProfile(db, {
    firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+15550100',
    city: 'Paris', country: 'France', linkedin: 'https://linkedin.com/in/ada',
  })
  setAnswerBank(db, { relocate: 'Yes' })
  deps = {
    db,
    runner: { complete: claudeComplete } as unknown as HandlerDeps['runner'],
    codex: { complete: codexComplete } as unknown as HandlerDeps['codex'],
    models: resolveModels({ optionPick: 'gpt-pick-test' }),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

const RELOCATE = { label: 'Are you open to relocation?', value: 'Yes', options: ['Select...', 'Yes, I would relocate', 'No'] }
const COUNTRY = { label: 'Country of residence', value: 'France', options: ['French Republic', 'Federal Republic of Germany', 'Kingdom of Spain'] }

async function pick(params: { label: string; value: string; options: string[] }): Promise<HostResponse> {
  return handleRequest(deps, { requestId: crypto.randomUUID(), method: 'option.pick', params } as HostRequest)
}

const promptSent = (): string => codexComplete.mock.calls[0]![0]

describe('option.pick', () => {
  it('answers with the position of the Option the model pointed at, and nothing else', async () => {
    codexComplete.mockImplementation(async () => ({ position: 1, value: 'Yes, definitely', text: 'I would love to move' }))
    const r = await pick(RELOCATE)
    expect(r).toMatchObject({ ok: true })
    if (!r.ok) throw new Error('failed')
    expect(r.result).toEqual({ position: 1 })
  })

  it('answers none when the model says none', async () => {
    const r = await pick(RELOCATE)
    if (!r.ok) throw new Error('failed')
    expect(r.result).toEqual({ position: null })
  })

  it.each([
    ['a position past the last Option', { position: 3 }],
    ['a negative position', { position: -1 }],
    ['an Option\'s text instead of a position', { position: 'No' }],
    ['a fraction', { position: 1.5 }],
    ['written text', 'Yes, I would relocate'],
  ])('answers none for %s', async (_what, reply) => {
    codexComplete.mockImplementation(async () => reply)
    const r = await pick(RELOCATE)
    if (!r.ok) throw new Error('failed')
    expect(r.result).toEqual({ position: null })
  })

  it('shows the model the label, the stored Value and the Options, and nothing else from the Profile', async () => {
    await pick(COUNTRY)
    const prompt = promptSent()
    expect(prompt).toContain('Country of residence')
    expect(prompt).toContain('<stored_answer>France</stored_answer>')
    for (const o of COUNTRY.options) expect(prompt).toContain(o)
    for (const other of ['Ada', 'Lovelace', 'ada@example.com', '5550100', 'Paris', 'linkedin']) {
      expect(prompt).not.toContain(other)
    }
  })

  it('runs on the Option pick model, through the structured-task runner', async () => {
    await pick(RELOCATE)
    expect(codexComplete).toHaveBeenCalledTimes(1)
    expect(codexComplete.mock.calls[0]![2]).toMatchObject({ model: 'gpt-pick-test' })
    expect(claudeComplete).not.toHaveBeenCalled()
  })

  it('a model call that fails answers an error the panel can name', async () => {
    codexComplete.mockImplementation(async () => { throw new CodexError('timeout', 'codex timed out') })
    const r = await pick(RELOCATE)
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } })
  })

  it('a failed pick is not replayed: the same request asks the model again', async () => {
    codexComplete.mockImplementationOnce(async () => { throw new CodexError('rate_limit', 'slow down') })
    const requestId = crypto.randomUUID()
    const req = { requestId, method: 'option.pick', params: RELOCATE } as HostRequest
    expect((await handleRequest(deps, req)).ok).toBe(false)
    codexComplete.mockImplementation(async () => ({ position: 2 }))
    expect(await handleRequest(deps, req)).toMatchObject({ ok: true, result: { position: 2 } })
  })
})
