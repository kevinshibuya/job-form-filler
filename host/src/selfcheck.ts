import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { SelfCheck } from '@jff/shared'
import { HOME_DIR } from './config.js'
import { ClaudeError, createClaudeRunner, type ClaudeRunner } from './llm/claudeCli.js'
import { CodexError, createCodexRunner, type CodexRunner } from './llm/codexCli.js'
import { log } from './log.js'
import { z } from 'zod'

const AUTH_CACHE_TTL_MS = 12 * 60 * 60 * 1000

/**
 * A sign-in probe asks for `{"ok":true}` and nothing else, so it needs nothing
 * like a real call's budget — but only the BANNER waits on it (the auto-scan
 * gate is bounded separately by HOST_WAIT_MS), and a probe killed early reports
 * a signed-in CLI as broken. A wrong red banner costs more than a late neutral
 * one, so the budget is generous and the saving comes from the single attempt:
 * worst case 180s, against the 482s a retried 240s spawn costs. Measured on
 * this machine: 15-20s idle, over 60s at load 12.
 */
const PROBE_OPTS = { timeoutMs: 180_000, retryTransient: false } as const

const PROBE_DETAIL_MAX = 200

/**
 * A failed probe's detail is rendered verbatim in the panel banner, and a
 * signed-out codex prints a page of websocket retries before it gives up. Keep
 * the last ERROR line — the one that says what actually failed — and cap it.
 * Callers log the full text first, so nothing is lost.
 */
export function summariseProbeFailure(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const errors = lines.filter((l) => /^ERROR:/i.test(l))
  const line = (errors.at(-1) ?? lines.at(-1) ?? 'the probe failed with no output')
    .replace(/^ERROR:\s*/i, '')
    .replace(/\s+/g, ' ')
  return line.length > PROBE_DETAIL_MAX ? `${line.slice(0, PROBE_DETAIL_MAX - 1)}…` : line
}

export interface AuthCacheEntry { ok: boolean; detail: string; at: string }
/** One entry per vendor. A legacy flat file (an AuthCacheEntry at the top
 *  level) is read as the claude entry. */
export interface AuthCacheFile { claude?: AuthCacheEntry; codex?: AuthCacheEntry }

export interface SelfCheckDeps {
  claudePath: string
  codexPath: string
  dbPath: string
  fileExists: (p: string) => boolean
  dbOk: () => boolean
  readAuthCache: () => AuthCacheFile | null
  writeAuthCache: (file: AuthCacheFile) => void
  probeAuth: () => Promise<{ ok: boolean; detail: string }>
  probeCodexAuth: () => Promise<{ ok: boolean; detail: string }>
  now: () => Date
}

export async function selfCheck(deps: SelfCheckDeps): Promise<SelfCheck> {
  const major = Number(process.version.replace(/^v/, '').split('.')[0])
  const node = { ok: Number.isFinite(major) && major >= 20, version: process.version }

  const claudeFound = deps.fileExists(deps.claudePath)
  const claude = {
    ok: claudeFound,
    path: deps.claudePath,
    detail: claudeFound ? 'found' : 'claude CLI not found at the configured path',
  }

  const codexFound = deps.fileExists(deps.codexPath)
  const codex = {
    ok: codexFound,
    path: deps.codexPath,
    detail: codexFound ? 'found' : 'codex CLI not found at the configured path',
  }

  const file = deps.readAuthCache()
  const isFresh = (e: AuthCacheEntry | undefined): boolean =>
    e !== undefined && deps.now().getTime() - new Date(e.at).getTime() < AUTH_CACHE_TTL_MS

  // Writing one vendor's entry must keep the other's. `merged` accumulates
  // across both arms: spreading the ORIGINAL `file` in each arm would make the
  // second write drop the entry the first one just made, so a cold cache would
  // re-probe one vendor on every open, forever.
  let merged: AuthCacheFile = { ...file }
  const cacheOk = (vendor: 'claude' | 'codex', v: { ok: boolean; detail: string }): void => {
    merged = { ...merged, [vendor]: { ...v, at: deps.now().toISOString() } }
    deps.writeAuthCache(merged)
  }

  // Both probes are real CLI round-trips and the host handles requests
  // serially, so running them in sequence puts the panel's first scan behind
  // two of them. They are independent; run them together.
  const resolveAuth = async (
    vendor: 'claude' | 'codex',
    found: boolean,
    cached: AuthCacheEntry | undefined,
    probe: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<{ ok: boolean; detail: string }> => {
    if (!found) return { ok: false, detail: `not checked (${vendor} CLI missing)` }
    if (isFresh(cached) && cached !== undefined) return { ok: cached.ok, detail: cached.detail }
    const result = await probe()
    // Never cache a failure: the user may log in a second later.
    if (result.ok) cacheOk(vendor, result)
    return result
  }

  const [auth, codexAuth] = await Promise.all([
    resolveAuth('claude', claudeFound, file?.claude, deps.probeAuth),
    resolveAuth('codex', codexFound, file?.codex, deps.probeCodexAuth),
  ])

  return { node, claude, auth, codex, codexAuth, db: { ok: deps.dbOk(), path: deps.dbPath } }
}

/* --------------------------------------------------------- real IO wiring */

export function realAuthCache(path: string): Pick<SelfCheckDeps, 'readAuthCache' | 'writeAuthCache'> {
  return {
    readAuthCache: () => {
      try {
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof raw !== 'object' || raw === null) return null
        // A legacy flat entry (ok + at at the top level) is the claude one.
        const flat = raw as Partial<AuthCacheEntry>
        if (typeof flat.ok === 'boolean' && typeof flat.at === 'string') {
          return { claude: flat as AuthCacheEntry }
        }
        return raw as AuthCacheFile
      } catch { return null }
    },
    writeAuthCache: (e) => {
      try { mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(path, JSON.stringify(e)) } catch { /* best effort */ }
    },
  }
}

/** One tiny real call: the only reliable signal that `claude` is logged in.
 *  `runner` is injectable so the call's options can be asserted without a spawn. */
export function realProbeAuth(
  claudePath: string,
  model: string,
  runner: ClaudeRunner = createClaudeRunner({ claudePath }),
): () => Promise<{ ok: boolean; detail: string }> {
  return async () => {
    try {
      await runner.complete('Reply with exactly {"ok":true}.', z.object({ ok: z.boolean() }), { model, ...PROBE_OPTS })
      return { ok: true, detail: 'logged in' }
    } catch (e) {
      if (e instanceof ClaudeError && e.kind === 'not_authed') return { ok: false, detail: 'claude CLI is not logged in. Run `claude` once in a terminal.' }
      if (e instanceof ClaudeError && e.kind === 'rate_limit') return { ok: true, detail: 'logged in (rate limited right now)' }
      const raw = e instanceof Error ? e.message : String(e)
      log('warn', 'claude sign-in probe failed', { detail: raw })
      return { ok: false, detail: summariseProbeFailure(raw) }
    }
  }
}

export const realFileExists = (p: string): boolean => existsSync(p)

/** The codex twin of realProbeAuth: one tiny real call, the only reliable
 *  signal that `codex` is signed in. */
export function realProbeCodexAuth(
  codexPath: string,
  model: string,
  runner: CodexRunner = createCodexRunner({ codexPath }),
): () => Promise<{ ok: boolean; detail: string }> {
  return async () => {
    try {
      await runner.complete('Reply with exactly {"ok":true}.', z.object({ ok: z.boolean() }), { model, ...PROBE_OPTS })
      return { ok: true, detail: 'logged in' }
    } catch (e) {
      if (e instanceof CodexError && e.kind === 'not_authed') return { ok: false, detail: 'codex CLI is not logged in. Run `codex login` in a terminal.' }
      if (e instanceof CodexError && e.kind === 'rate_limit') return { ok: true, detail: 'logged in (rate limited right now)' }
      const raw = e instanceof Error ? e.message : String(e)
      log('warn', 'codex sign-in probe failed', { detail: raw })
      return { ok: false, detail: summariseProbeFailure(raw) }
    }
  }
}
