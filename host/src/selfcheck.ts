import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { SelfCheck } from '@jff/shared'
import { HOME_DIR } from './config.js'
import { ClaudeError, createClaudeRunner } from './llm/claudeCli.js'
import { CodexError, createCodexRunner } from './llm/codexCli.js'
import { z } from 'zod'

const AUTH_CACHE_TTL_MS = 12 * 60 * 60 * 1000

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

/** One tiny real call: the only reliable signal that `claude` is logged in. */
export function realProbeAuth(claudePath: string, model: string): () => Promise<{ ok: boolean; detail: string }> {
  return async () => {
    const runner = createClaudeRunner({ claudePath })
    try {
      await runner.complete('Reply with exactly {"ok":true}.', z.object({ ok: z.boolean() }), { model })
      return { ok: true, detail: 'logged in' }
    } catch (e) {
      if (e instanceof ClaudeError && e.kind === 'not_authed') return { ok: false, detail: 'claude CLI is not logged in. Run `claude` once in a terminal.' }
      if (e instanceof ClaudeError && e.kind === 'rate_limit') return { ok: true, detail: 'logged in (rate limited right now)' }
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  }
}

export const realFileExists = (p: string): boolean => existsSync(p)

/** The codex twin of realProbeAuth: one tiny real call, the only reliable
 *  signal that `codex` is signed in. */
export function realProbeCodexAuth(codexPath: string, model: string): () => Promise<{ ok: boolean; detail: string }> {
  return async () => {
    const runner = createCodexRunner({ codexPath })
    try {
      await runner.complete('Reply with exactly {"ok":true}.', z.object({ ok: z.boolean() }), { model, retryTransient: false })
      return { ok: true, detail: 'logged in' }
    } catch (e) {
      if (e instanceof CodexError && e.kind === 'not_authed') return { ok: false, detail: 'codex CLI is not logged in. Run `codex login` in a terminal.' }
      if (e instanceof CodexError && e.kind === 'rate_limit') return { ok: true, detail: 'logged in (rate limited right now)' }
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  }
}
