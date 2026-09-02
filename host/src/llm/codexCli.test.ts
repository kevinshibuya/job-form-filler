import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildCodexArgv, createCodexRunner, isTimeoutSignal, type CodexRunFn, type CodexRunResult } from './codexCli.js'

// Production always passes a CallOpts; the tests must too, or they exercise
// a shape that never occurs (host/tsconfig.json excludes tests from tsc).
const OPTS = { model: 'gpt-5.6-sol' }

const schema = z.object({ draft: z.string() })
const okRun = (output: string): CodexRunFn => async () => ({ code: 0, output, stderr: '', timedOut: false })

describe('createCodexRunner', () => {
  it('parses the -o file content (loose JSON) and validates the schema', async () => {
    const r = createCodexRunner({ run: okRun('Sure!\n```json\n{"draft":"tight"}\n```') })
    await expect(r.complete('p', schema, OPTS)).resolves.toEqual({ draft: 'tight' })
  })

  it('classifies a missing binary as not_installed', async () => {
    const run: CodexRunFn = async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) }
    await expect(createCodexRunner({ run }).complete('p', schema, OPTS)).rejects.toMatchObject({ kind: 'not_installed' })
  })

  it('classifies a timeout kill', async () => {
    const run: CodexRunFn = async () => ({ code: 1, output: '', stderr: '', timedOut: true })
    await expect(createCodexRunner({ run }).complete('p', schema, OPTS)).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('classifies a non-zero exit as process with stderr as the message', async () => {
    const run: CodexRunFn = async () => ({ code: 2, output: '', stderr: 'boom', timedOut: false })
    await expect(createCodexRunner({ run }).complete('p', schema, OPTS)).rejects.toMatchObject({ kind: 'process', message: 'boom' })
  })

  it('classifies schema-invalid output as invalid_output, with NO retry (the caller degrades)', async () => {
    const run = vi.fn<CodexRunFn>(okRun('not json at all'))
    await expect(createCodexRunner({ run }).complete('p', schema, OPTS)).rejects.toMatchObject({ kind: 'invalid_output' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('createCodexRunner: transient retry and terminal classification', () => {
  const nap = () => Promise.resolve()
  const timedOut: CodexRunResult = { code: 1, output: '', stderr: '', timedOut: true }

  it('retries once after a timeout and returns the parsed result', async () => {
    const run = vi.fn<CodexRunFn>()
      .mockResolvedValueOnce(timedOut)
      .mockResolvedValueOnce({ code: 0, output: '{"draft":"second try"}', stderr: '', timedOut: false })
    const r = createCodexRunner({ run, sleep: nap })
    await expect(r.complete('p', schema, OPTS)).resolves.toEqual({ draft: 'second try' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('gives up after two timeouts', async () => {
    const run = vi.fn<CodexRunFn>().mockResolvedValue(timedOut)
    await expect(createCodexRunner({ run, sleep: nap }).complete('p', schema, OPTS))
      .rejects.toMatchObject({ kind: 'timeout' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retries once on a plain process failure', async () => {
    const run = vi.fn<CodexRunFn>().mockResolvedValue({ code: 2, output: '', stderr: 'boom', timedOut: false })
    await expect(createCodexRunner({ run, sleep: nap }).complete('p', schema, OPTS))
      .rejects.toMatchObject({ kind: 'process', message: 'boom' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('throws rate_limit at once on a usage-limit stderr', async () => {
    const run = vi.fn<CodexRunFn>().mockResolvedValue({ code: 1, output: '', stderr: 'usage limit reached', timedOut: false })
    await expect(createCodexRunner({ run, sleep: nap }).complete('p', schema, OPTS))
      .rejects.toMatchObject({ kind: 'rate_limit' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('throws not_authed at once when codex is not signed in', async () => {
    const run = vi.fn<CodexRunFn>().mockResolvedValue({ code: 1, output: '', stderr: 'Error: not logged in', timedOut: false })
    await expect(createCodexRunner({ run, sleep: nap }).complete('p', schema, OPTS))
      .rejects.toMatchObject({ kind: 'not_authed' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('classifies a rate limit that also mentions auth as rate_limit', async () => {
    const run = vi.fn<CodexRunFn>().mockResolvedValue({ code: 1, output: '', stderr: 'authentication rate limit exceeded', timedOut: false })
    await expect(createCodexRunner({ run, sleep: nap }).complete('p', schema, OPTS))
      .rejects.toMatchObject({ kind: 'rate_limit' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('throws not_installed at once when the binary is missing', async () => {
    const run = vi.fn<CodexRunFn>(async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) })
    await expect(createCodexRunner({ run, sleep: nap }).complete('p', schema, OPTS))
      .rejects.toMatchObject({ kind: 'not_installed' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not retry invalid output', async () => {
    const run = vi.fn<CodexRunFn>(okRun('not json at all'))
    await expect(createCodexRunner({ run, sleep: nap }).complete('p', schema, OPTS))
      .rejects.toMatchObject({ kind: 'invalid_output' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retryTransient false takes the single bounded attempt the review pass needs', async () => {
    // The draft review and the sign-in probes opt out: a second full-budget
    // attempt delays the degrade-to-unreviewed path instead of saving it.
    const run = vi.fn().mockResolvedValue(timedOut)
    await expect(createCodexRunner({ run, sleep: nap })
      .complete('p', schema, { model: 'gpt-5.6-sol', retryTransient: false }))
      .rejects.toMatchObject({ kind: 'timeout' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('sleeps 2s before the retry', async () => {
    const sleep = vi.fn(() => Promise.resolve())
    const run = vi.fn<CodexRunFn>().mockResolvedValue(timedOut)
    await expect(createCodexRunner({ run, sleep }).complete('p', schema, OPTS)).rejects.toThrow()
    expect(sleep).toHaveBeenCalledWith(2_000)
  })
})

describe('isTimeoutSignal (review fix: SIGKILL deadline)', () => {
  it('classifies a SIGTERM-killed close as a timeout', () => {
    expect(isTimeoutSignal(null, 'SIGTERM')).toBe(true)
  })

  it('classifies a SIGKILL-killed close as a timeout (a SIGTERM-trapping codex escalated to SIGKILL)', () => {
    expect(isTimeoutSignal(null, 'SIGKILL')).toBe(true)
  })

  it('does not classify a normal exit as a timeout', () => {
    expect(isTimeoutSignal(0, null)).toBe(false)
  })

  it('does not classify an unrelated signal as a timeout', () => {
    expect(isTimeoutSignal(null, 'SIGINT')).toBe(false)
  })
})


describe('buildCodexArgv', () => {
  it('passes the model after -m and the out file after -o, prompt last', () => {
    expect(buildCodexArgv('hello', { model: 'gpt-5.6-sol' }, '/tmp/o.md')).toEqual([
      'exec', '-m', 'gpt-5.6-sol', '-s', 'read-only', '--ephemeral',
      '--skip-git-repo-check', '--color', 'never', '-o', '/tmp/o.md', 'hello',
    ])
  })

  it('carries whatever model the caller names', () => {
    expect(buildCodexArgv('p', { model: 'gpt-5.6-luna' }, '/tmp/o.md')).toContain('gpt-5.6-luna')
  })
})
