import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { z } from 'zod'
import { parseLooseJson, type CallOpts, type SleepFn } from './claudeCli.js'

/** The runner's default budget. Callers that need longer pass `timeoutMs`
 *  per call; the review pass keeps this default so it never holds generation
 *  hostage. */
const CODEX_TIMEOUT_MS = 120_000
const TRANSIENT_BACKOFF_MS = 2_000

// Order matters: "authentication rate limit exceeded" matches AUTH_RE too and
// must classify as rate_limit, exactly as the claude runner does.
const RATE_LIMIT_RE = /rate.?limit|429|overloaded|too many requests|usage limit/i
const AUTH_RE = /not logged in|login|auth|unauthor|sign.?in/i

export class CodexError extends Error {
  constructor(
    readonly kind: 'not_installed' | 'not_authed' | 'rate_limit' | 'process' | 'timeout' | 'invalid_output',
    message: string,
  ) {
    super(message)
    this.name = 'CodexError'
  }
}

export type CodexRunResult = { code: number; output: string; stderr: string; timedOut: boolean }
export type CodexRunFn = (prompt: string, opts: CallOpts) => Promise<CodexRunResult>

/** Pure so the argv can be asserted without spawning anything. */
export function buildCodexArgv(prompt: string, opts: CallOpts, outFile: string): string[] {
  return ['exec', '-m', opts.model, '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '-o', outFile, prompt]
}

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
  complete<T>(prompt: string, schema: z.ZodType<T>, opts: CallOpts): Promise<T>
}

/**
 * Non-interactive codex (verified on this machine 2026-07-29): exec mode
 * writes the FINAL agent message to the -o file; stdout carries a transcript
 * that must never be parsed. read-only sandbox, ephemeral session, no repo
 * checks — the host may run from any cwd.
 */
export function defaultCodexRun(codexPath: string): CodexRunFn {
  return (prompt, opts) =>
    new Promise<CodexRunResult>((resolve, reject) => {
      const dir = mkdtempSync(join(tmpdir(), 'jff-codex-'))
      const outFile = join(dir, 'out.md')
      const child = spawn(
        codexPath,
        buildCodexArgv(prompt, opts, outFile),
        // killSignal: SIGTERM alone lets a codex process that traps SIGTERM
        // survive past the deadline; SIGKILL cannot be trapped or ignored.
        { timeout: opts.timeoutMs ?? CODEX_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'pipe'] },
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

export function createCodexRunner(
  opts: { codexPath?: string; run?: CodexRunFn; sleep?: SleepFn } = {},
): CodexRunner {
  const run = opts.run ?? defaultCodexRun(opts.codexPath ?? 'codex')
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  return {
    async complete<T>(prompt: string, schema: z.ZodType<T>, opts: CallOpts): Promise<T> {
      const wrapped = `${prompt}\n\nRespond with ONLY a single JSON value matching the schema described above. No prose, no code fences.`
      let transientUsed = 0

      for (;;) {
        let err: CodexError
        let res: CodexRunResult | undefined

        try {
          res = await run(wrapped, opts)
        } catch (e) {
          const e2 = e as NodeJS.ErrnoException
          err = e2?.code === 'ENOENT'
            ? new CodexError('not_installed', 'the `codex` CLI was not found at the configured path')
            : new CodexError('process', e2?.message ?? String(e))
        }

        if (res) {
          if (res.timedOut) {
            err = new CodexError('timeout', `codex exec exceeded the call's time budget`)
          } else if (res.code !== 0) {
            const stderr = res.stderr.trim()
            if (RATE_LIMIT_RE.test(res.stderr)) err = new CodexError('rate_limit', 'codex subscription rate limit reached')
            else if (AUTH_RE.test(res.stderr)) err = new CodexError('not_authed', 'codex CLI is not logged in')
            else err = new CodexError('process', stderr || `codex exited ${res.code}`)
          } else {
            try {
              return schema.parse(parseLooseJson(res.output))
            } catch (e) {
              throw new CodexError('invalid_output', `codex did not return schema-valid JSON: ${String(e)}`)
            }
          }
        }

        // Terminal kinds name codex and throw at once; only timeout and process
        // get the one retry.
        const kind = err!.kind
        if (kind !== 'timeout' && kind !== 'process') throw err!
        if (opts.retryTransient === false) throw err!
        if (transientUsed++ >= 1) throw err!
        await sleep(TRANSIENT_BACKOFF_MS)
      }
    },
  }
}
