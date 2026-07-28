import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { HostErrorKind } from '@jff/shared'

const SPAWN_TIMEOUT_MS = 240_000
const TRANSIENT_BACKOFF_MS = 2_000

const AUTH_RE = /auth|login|unauthor/i
const RATE_LIMIT_RE = /rate.?limit|429|overloaded|too many requests|usage limit/i

export class ClaudeError extends Error {
  constructor(readonly kind: HostErrorKind, message: string) {
    super(message)
    this.name = 'ClaudeError'
  }
}

export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type RunFn = (prompt: string) => Promise<RunResult>
export type SleepFn = (ms: number) => Promise<void>

export interface ClaudeRunner {
  complete<T>(prompt: string, schema: z.ZodType<T>): Promise<T>
}

/**
 * `stdio: ['ignore', ...]` closes the child's stdin. Without it `claude -p` waits
 * ~3s for stdin on EVERY call and writes a warning to stderr that masks the real
 * failure message. The prompt goes through argv (-p), never stdin.
 */
export function defaultRun(claudePath: string): RunFn {
  return (prompt) =>
    new Promise<RunResult>((resolve, reject) => {
      const child = spawn(claudePath, ['-p', prompt, '--output-format', 'json'], {
        timeout: SPAWN_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      child.on('error', reject)
      child.on('close', (code, signal) => {
        // A timeout kill arrives as code=null with signal=SIGTERM.
        resolve({ code: code ?? 1, stdout, stderr, timedOut: code === null && signal === 'SIGTERM' })
      })
    })
}

/** Model output may be wrapped in prose or code fences; find the JSON body. */
function parseLooseJson(text: string): unknown {
  const t = text.trim()
  try { return JSON.parse(t) } catch { /* fall through */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t)
  if (fenced?.[1]) { try { return JSON.parse(fenced[1].trim()) } catch { /* fall through */ } }
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const first = t.indexOf(open)
    const last = t.lastIndexOf(close)
    if (first !== -1 && last > first) {
      try { return JSON.parse(t.slice(first, last + 1)) } catch { /* try the next shape */ }
    }
  }
  throw new Error('no JSON value found in model output')
}

type FailureClass = 'terminal' | 'transient' | 'parse'

export function createClaudeRunner(opts: { claudePath?: string; run?: RunFn; sleep?: SleepFn } = {}): ClaudeRunner {
  const run = opts.run ?? defaultRun(opts.claudePath ?? 'claude')
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  return {
    async complete<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
      const wrapped = `${prompt}\n\nRespond with ONLY a single JSON value matching the schema described above. No prose, no code fences, no explanation.`
      let transientUsed = 0
      let parseUsed = 0

      for (;;) {
        let kind: HostErrorKind
        let message: string
        let cls: FailureClass
        let res: RunResult | undefined

        try {
          res = await run(wrapped)
        } catch (e: unknown) {
          const err = e as NodeJS.ErrnoException
          if (err?.code === 'ENOENT') {
            kind = 'not_installed'; message = 'the `claude` CLI was not found at the configured path'; cls = 'terminal'
          } else {
            kind = 'process'; message = err?.message ?? String(e); cls = 'transient'
          }
        }

        if (res) {
          if (res.timedOut) {
            kind = 'timeout'; message = `claude -p exceeded ${SPAWN_TIMEOUT_MS}ms`; cls = 'transient'
          } else if (res.code !== 0) {
            // RATE_LIMIT first: "authentication rate limit exceeded" also matches
            // AUTH_RE and must classify as rate_limit, not not_authed.
            if (RATE_LIMIT_RE.test(res.stderr)) { kind = 'rate_limit'; message = 'claude subscription rate limit reached'; cls = 'terminal' }
            else if (AUTH_RE.test(res.stderr)) { kind = 'not_authed'; message = 'claude CLI is not logged in'; cls = 'terminal' }
            else { kind = 'process'; message = res.stderr.trim() || `claude exited ${res.code}`; cls = 'transient' }
          } else {
            try {
              const envelope: unknown = JSON.parse(res.stdout)
              const inner = (envelope as { result?: unknown } | null)?.result
              const text = typeof inner === 'string' ? inner : res.stdout
              return schema.parse(parseLooseJson(text))
            } catch (e) {
              kind = 'invalid_output'; message = `claude did not return schema-valid JSON: ${String(e)}`; cls = 'parse'
            }
          }
        }

        if (cls! === 'terminal') throw new ClaudeError(kind!, message!)
        if (cls! === 'parse') {
          if (parseUsed++ >= 1) throw new ClaudeError(kind!, message!)
          continue // immediate retry — a formatting glitch needs no backoff
        }
        if (transientUsed++ >= 1) throw new ClaudeError(kind!, message!)
        await sleep(TRANSIENT_BACKOFF_MS)
      }
    },
  }
}
