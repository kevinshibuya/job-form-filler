import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildArgv, createClaudeRunner, ClaudeError, type RunResult } from './claudeCli.js'

const Schema = z.object({ ok: z.boolean() })
const noSleep = () => Promise.resolve()
const OPTS = { model: 'claude-opus-5' }
const envelope = (payload: unknown): RunResult => ({
  code: 0, stdout: JSON.stringify({ type: 'result', result: JSON.stringify(payload) }), stderr: '', timedOut: false,
})

describe('createClaudeRunner', () => {
  it('parses the claude JSON envelope and validates against the schema', async () => {
    const run = vi.fn(async () => envelope({ ok: true }))
    const r = createClaudeRunner({ run, sleep: noSleep })
    await expect(r.complete('p', Schema, OPTS)).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('tolerates prose and code fences around the JSON', async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({
      code: 0,
      stdout: JSON.stringify({ type: 'result', result: 'Sure!\n```json\n{"ok":true}\n```' }),
      stderr: '', timedOut: false,
    }))
    await expect(createClaudeRunner({ run, sleep: noSleep }).complete('p', Schema, OPTS)).resolves.toEqual({ ok: true })
  })

  it('classifies spawn ENOENT as not_installed and does not retry', async () => {
    const run = vi.fn(async () => {
      const e = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      e.code = 'ENOENT'
      throw e
    })
    await expect(createClaudeRunner({ run, sleep: noSleep }).complete('p', Schema, OPTS))
      .rejects.toMatchObject({ kind: 'not_installed' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('classifies an auth failure as not_authed and does not retry', async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: 'Error: not logged in, please run login', timedOut: false }))
    await expect(createClaudeRunner({ run, sleep: noSleep }).complete('p', Schema, OPTS))
      .rejects.toMatchObject({ kind: 'not_authed' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('classifies a usage limit as rate_limit and does not retry', async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: 'Claude usage limit reached', timedOut: false }))
    await expect(createClaudeRunner({ run, sleep: noSleep }).complete('p', Schema, OPTS))
      .rejects.toMatchObject({ kind: 'rate_limit' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('classifies "authentication rate limit exceeded" as rate_limit, not not_authed', async () => {
    // Both regexes match this string; the rate-limit test must run FIRST.
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: 'authentication rate limit exceeded', timedOut: false }))
    await expect(createClaudeRunner({ run, sleep: noSleep }).complete('p', Schema, OPTS))
      .rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('classifies a timeout kill as timeout and retries exactly once', async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: '', timedOut: true }))
    await expect(createClaudeRunner({ run, sleep: noSleep }).complete('p', Schema, OPTS))
      .rejects.toMatchObject({ kind: 'timeout' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('honours retryTransient: false and makes exactly one attempt', async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: '', timedOut: true }))
    await expect(createClaudeRunner({ run, sleep: noSleep })
      .complete('p', Schema, { ...OPTS, retryTransient: false }))
      .rejects.toMatchObject({ kind: 'timeout' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('still retries a transient failure when retryTransient is left unset', async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 137, stdout: '', stderr: 'killed', timedOut: false }))
    await expect(createClaudeRunner({ run, sleep: noSleep }).complete('p', Schema, OPTS))
      .rejects.toMatchObject({ kind: 'process' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retries a transient process failure once and succeeds on the retry', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 137, stdout: '', stderr: 'killed', timedOut: false } satisfies RunResult)
      .mockResolvedValueOnce(envelope({ ok: true }))
    await expect(createClaudeRunner({ run, sleep: noSleep }).complete('p', Schema, OPTS)).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retries invalid output once then fails closed with invalid_output', async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 0, stdout: 'not json at all', stderr: '', timedOut: false }))
    const err = await createClaudeRunner({ run, sleep: noSleep }).complete('p', Schema, OPTS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ClaudeError)
    expect((err as ClaudeError).kind).toBe('invalid_output')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('appends a JSON-only instruction so the CLI cannot answer in prose', async () => {
    const run = vi.fn(async () => envelope({ ok: true }))
    await createClaudeRunner({ run, sleep: noSleep }).complete('MY PROMPT', Schema, OPTS)
    const sent = run.mock.calls[0]![0] as string
    expect(sent.startsWith('MY PROMPT')).toBe(true)
    expect(sent).toMatch(/ONLY a single JSON/i)
  })
})


describe('buildArgv', () => {
  it('names the model explicitly and asks for the json envelope', () => {
    expect(buildArgv('hello', { model: 'claude-opus-5' }))
      .toEqual(['-p', 'hello', '--model', 'claude-opus-5', '--output-format', 'json'])
  })

  it('carries whatever model the caller names', () => {
    expect(buildArgv('p', { model: 'claude-fable-5-1' })).toContain('claude-fable-5-1')
  })
})
