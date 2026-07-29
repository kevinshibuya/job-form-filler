import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { z } from 'zod'
import { parseLooseJson } from './claudeCli.js'

/** B2d: the review pass must never hold generation hostage — 120s, then degrade. */
const CODEX_TIMEOUT_MS = 120_000

export class CodexError extends Error {
  constructor(readonly kind: 'not_installed' | 'process' | 'timeout' | 'invalid_output', message: string) {
    super(message)
    this.name = 'CodexError'
  }
}

export type CodexRunResult = { code: number; output: string; stderr: string; timedOut: boolean }
export type CodexRunFn = (prompt: string) => Promise<CodexRunResult>

/**
 * Node's `timeout` option below kills the child with `killSignal` on the
 * deadline; a codex that traps SIGTERM survives unless we escalate to
 * SIGKILL (unblockable), so `close` can now report EITHER signal for the same
 * "we killed it on the deadline" event — both must classify as a timeout.
 */
export function isTimeoutSignal(code: number | null, signal: NodeJS.Signals | null): boolean {
  return code === null && (signal === 'SIGTERM' || signal === 'SIGKILL')
}

export interface CodexRunner {
  complete<T>(prompt: string, schema: z.ZodType<T>): Promise<T>
}

/**
 * Non-interactive codex (verified on this machine 2026-07-29): exec mode
 * writes the FINAL agent message to the -o file; stdout carries a transcript
 * that must never be parsed. read-only sandbox, ephemeral session, no repo
 * checks — the host may run from any cwd.
 */
export function defaultCodexRun(codexPath: string): CodexRunFn {
  return (prompt) =>
    new Promise<CodexRunResult>((resolve, reject) => {
      const dir = mkdtempSync(join(tmpdir(), 'jff-codex-'))
      const outFile = join(dir, 'out.md')
      const child = spawn(
        codexPath,
        ['exec', '-m', 'gpt-5.6-sol', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '-o', outFile, prompt],
        // killSignal: SIGTERM alone lets a codex process that traps SIGTERM
        // survive past the 120s deadline; SIGKILL cannot be trapped or ignored.
        { timeout: CODEX_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'pipe'] },
      )
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      const collect = (): string => {
        let out = ''
        try { out = readFileSync(outFile, 'utf8') } catch { /* never written */ }
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
        return out
      }
      child.on('error', (e) => { collect(); reject(e) })
      child.on('close', (code, signal) => {
        resolve({ code: code ?? 1, output: collect(), stderr, timedOut: isTimeoutSignal(code, signal) })
      })
    })
}

export function createCodexRunner(opts: { codexPath?: string; run?: CodexRunFn } = {}): CodexRunner {
  const run = opts.run ?? defaultCodexRun(opts.codexPath ?? 'codex')
  return {
    async complete<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
      const wrapped = `${prompt}\n\nRespond with ONLY a single JSON value matching the schema described above. No prose, no code fences.`
      let res: CodexRunResult
      try {
        res = await run(wrapped)
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        throw err?.code === 'ENOENT'
          ? new CodexError('not_installed', 'the `codex` CLI was not found at the configured path')
          : new CodexError('process', err?.message ?? String(e))
      }
      if (res.timedOut) throw new CodexError('timeout', `codex exec exceeded ${CODEX_TIMEOUT_MS}ms`)
      if (res.code !== 0) throw new CodexError('process', res.stderr.trim() || `codex exited ${res.code}`)
      try {
        return schema.parse(parseLooseJson(res.output))
      } catch (e) {
        throw new CodexError('invalid_output', `codex did not return schema-valid JSON: ${String(e)}`)
      }
    },
  }
}
