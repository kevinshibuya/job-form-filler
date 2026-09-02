import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { SelfCheck } from '@jff/shared'
import { HOME_DIR } from './config.js'
import { ClaudeError, createClaudeRunner } from './llm/claudeCli.js'
import { z } from 'zod'

const AUTH_CACHE_TTL_MS = 12 * 60 * 60 * 1000

export interface AuthCacheEntry { ok: boolean; detail: string; at: string }

export interface SelfCheckDeps {
  claudePath: string
  dbPath: string
  fileExists: (p: string) => boolean
  dbOk: () => boolean
  readAuthCache: () => AuthCacheEntry | null
  writeAuthCache: (e: AuthCacheEntry) => void
  probeAuth: () => Promise<{ ok: boolean; detail: string }>
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

  let auth = { ok: false, detail: 'not checked (claude CLI missing)' }
  if (claudeFound) {
    const cached = deps.readAuthCache()
    const fresh = cached !== null && deps.now().getTime() - new Date(cached.at).getTime() < AUTH_CACHE_TTL_MS
    if (fresh && cached !== null) {
      auth = { ok: cached.ok, detail: cached.detail }
    } else {
      auth = await deps.probeAuth()
      // Never cache a failure: the user may log in a second later.
      if (auth.ok) deps.writeAuthCache({ ...auth, at: deps.now().toISOString() })
    }
  }

  return { node, claude, auth, db: { ok: deps.dbOk(), path: deps.dbPath } }
}

/* --------------------------------------------------------- real IO wiring */

export function realAuthCache(path: string): Pick<SelfCheckDeps, 'readAuthCache' | 'writeAuthCache'> {
  return {
    readAuthCache: () => {
      try { return JSON.parse(readFileSync(path, 'utf8')) as AuthCacheEntry } catch { return null }
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
