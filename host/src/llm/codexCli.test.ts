import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createCodexRunner, type CodexRunFn } from './codexCli.js'

const schema = z.object({ draft: z.string() })
const okRun = (output: string): CodexRunFn => async () => ({ code: 0, output, stderr: '', timedOut: false })

describe('createCodexRunner', () => {
  it('parses the -o file content (loose JSON) and validates the schema', async () => {
    const r = createCodexRunner({ run: okRun('Sure!\n```json\n{"draft":"tight"}\n```') })
    await expect(r.complete('p', schema)).resolves.toEqual({ draft: 'tight' })
  })

  it('classifies a missing binary as not_installed', async () => {
    const run: CodexRunFn = async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) }
    await expect(createCodexRunner({ run }).complete('p', schema)).rejects.toMatchObject({ kind: 'not_installed' })
  })

  it('classifies a timeout kill', async () => {
    const run: CodexRunFn = async () => ({ code: 1, output: '', stderr: '', timedOut: true })
    await expect(createCodexRunner({ run }).complete('p', schema)).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('classifies a non-zero exit as process with stderr as the message', async () => {
    const run: CodexRunFn = async () => ({ code: 2, output: '', stderr: 'boom', timedOut: false })
    await expect(createCodexRunner({ run }).complete('p', schema)).rejects.toMatchObject({ kind: 'process', message: 'boom' })
  })

  it('classifies schema-invalid output as invalid_output, with NO retry (the caller degrades)', async () => {
    const run = vi.fn<CodexRunFn>(okRun('not json at all'))
    await expect(createCodexRunner({ run }).complete('p', schema)).rejects.toMatchObject({ kind: 'invalid_output' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
