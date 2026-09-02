import { describe, it, expect, vi } from 'vitest'
import { realAuthCache, selfCheck } from './selfcheck.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = {
  claudePath: '/opt/homebrew/bin/claude',
  codexPath: '/opt/homebrew/bin/codex',
  dbPath: '/tmp/jff-test.sqlite',
  fileExists: () => true,
  dbOk: () => true,
  readAuthCache: () => null,
  writeAuthCache: vi.fn(),
  probeCodexAuth: async () => ({ ok: true, detail: 'logged in' }),
  now: () => new Date('2026-07-27T12:00:00Z'),
}

describe('selfCheck', () => {
  it('reports node ok on the current runtime (the plan pins Node >= 20)', async () => {
    const r = await selfCheck({ ...base, probeAuth: async () => ({ ok: true, detail: 'ok' }) })
    expect(r.node.ok).toBe(true)
    expect(r.node.version).toBe(process.version)
  })

  it('reports claude not found when the configured path does not exist', async () => {
    const r = await selfCheck({ ...base, fileExists: () => false, probeAuth: async () => ({ ok: true, detail: 'ok' }) })
    expect(r.claude).toMatchObject({ ok: false })
    expect(r.claude.detail).toMatch(/not found/i)
  })

  it('does not probe auth when the claude binary is missing', async () => {
    const probeAuth = vi.fn(async () => ({ ok: true, detail: 'ok' }))
    await selfCheck({ ...base, fileExists: () => false, probeAuth })
    expect(probeAuth).not.toHaveBeenCalled()
  })

  it('reuses a cached auth result younger than 12 hours', async () => {
    const probeAuth = vi.fn(async () => ({ ok: true, detail: 'fresh' }))
    const r = await selfCheck({
      ...base, probeAuth,
      readAuthCache: () => ({ claude: { ok: true, detail: 'cached', at: '2026-07-27T06:00:00Z' } }),
    })
    expect(probeAuth).not.toHaveBeenCalled()
    expect(r.auth).toEqual({ ok: true, detail: 'cached' })
  })

  it('re-probes when the cached auth result is older than 12 hours', async () => {
    const probeAuth = vi.fn(async () => ({ ok: true, detail: 'fresh' }))
    const r = await selfCheck({
      ...base, probeAuth,
      readAuthCache: () => ({ claude: { ok: true, detail: 'stale', at: '2026-07-26T06:00:00Z' } }),
    })
    expect(probeAuth).toHaveBeenCalledTimes(1)
    expect(r.auth.detail).toBe('fresh')
  })

  it('never caches a failed auth probe', async () => {
    const writeAuthCache = vi.fn()
    await selfCheck({
      ...base, writeAuthCache,
      probeAuth: async () => ({ ok: false, detail: 'not logged in' }),
      // Keep codex failing too, so nothing at all is written and the claim
      // stays exactly what it was before the second vendor existed.
      probeCodexAuth: async () => ({ ok: false, detail: 'not logged in' }),
    })
    expect(writeAuthCache).not.toHaveBeenCalled()
  })

  it('caches the succeeding vendor even when the other probe fails', async () => {
    const writeAuthCache = vi.fn()
    await selfCheck({
      ...base, writeAuthCache,
      probeAuth: async () => ({ ok: false, detail: 'not logged in' }),
      probeCodexAuth: async () => ({ ok: true, detail: 'codex in' }),
    })
    expect(writeAuthCache).toHaveBeenCalledTimes(1)
    expect(writeAuthCache.mock.calls[0][0].claude).toBeUndefined()
    expect(writeAuthCache.mock.calls[0][0].codex).toMatchObject({ ok: true })
  })

  it('probes both vendors when neither cache entry exists', async () => {
    const probeAuth = vi.fn(async () => ({ ok: true, detail: 'claude in' }))
    const probeCodexAuth = vi.fn(async () => ({ ok: true, detail: 'codex in' }))
    const r = await selfCheck({ ...base, probeAuth, probeCodexAuth })
    expect(probeAuth).toHaveBeenCalledTimes(1)
    expect(probeCodexAuth).toHaveBeenCalledTimes(1)
    expect(r.codexAuth).toEqual({ ok: true, detail: 'codex in' })
  })

  it('skips the codex probe when its cache entry is fresh', async () => {
    const probeCodexAuth = vi.fn(async () => ({ ok: true, detail: 'fresh' }))
    const r = await selfCheck({
      ...base, probeCodexAuth,
      probeAuth: async () => ({ ok: true, detail: 'ok' }),
      readAuthCache: () => ({ codex: { ok: true, detail: 'cached codex', at: '2026-07-27T06:00:00Z' } }),
    })
    expect(probeCodexAuth).not.toHaveBeenCalled()
    expect(r.codexAuth).toEqual({ ok: true, detail: 'cached codex' })
  })

  it('reports codex not found when the configured path does not exist', async () => {
    const probeCodexAuth = vi.fn(async () => ({ ok: true, detail: 'never' }))
    const r = await selfCheck({
      ...base, probeCodexAuth,
      probeAuth: async () => ({ ok: true, detail: 'ok' }),
      fileExists: (p: string) => p !== base.codexPath,
    })
    expect(r.codex).toMatchObject({ ok: false })
    expect(r.codex.detail).toMatch(/codex CLI not found/i)
    expect(probeCodexAuth).not.toHaveBeenCalled()
  })

  it('surfaces a codex sign-in failure as codexAuth.ok false', async () => {
    const r = await selfCheck({
      ...base,
      probeAuth: async () => ({ ok: true, detail: 'ok' }),
      probeCodexAuth: async () => ({ ok: false, detail: 'codex CLI is not logged in. Run `codex login` in a terminal.' }),
    })
    expect(r.codexAuth.ok).toBe(false)
    expect(r.codexAuth.detail).toMatch(/codex login/)
  })

  it('caching BOTH vendors in one run keeps both — the second write must not drop the first', async () => {
    // The bug this pins: each arm spreading the ORIGINAL cache file means the
    // codex write clobbers the claude entry written moments earlier, so a cold
    // cache re-probes claude on every open forever.
    const writeAuthCache = vi.fn()
    await selfCheck({
      ...base, writeAuthCache,
      readAuthCache: () => null,
      probeAuth: async () => ({ ok: true, detail: 'claude in' }),
      probeCodexAuth: async () => ({ ok: true, detail: 'codex in' }),
    })
    expect(writeAuthCache).toHaveBeenCalledTimes(2)
    const last = writeAuthCache.mock.calls[1][0]
    expect(last.claude).toMatchObject({ ok: true, detail: 'claude in' })
    expect(last.codex).toMatchObject({ ok: true, detail: 'codex in' })
  })

  it('caching one vendor keeps the other vendor entry', async () => {
    const writeAuthCache = vi.fn()
    await selfCheck({
      ...base, writeAuthCache,
      probeAuth: async () => ({ ok: true, detail: 'claude in' }),
      probeCodexAuth: async () => ({ ok: false, detail: 'codex out' }),
      readAuthCache: () => ({ codex: { ok: true, detail: 'old codex', at: '2026-07-20T06:00:00Z' } }),
    })
    // The codex probe failed, so only claude is written — and the stale codex
    // entry survives the write rather than being dropped.
    const written = writeAuthCache.mock.calls[0][0]
    expect(written.claude).toMatchObject({ ok: true, detail: 'claude in' })
    expect(written.codex).toMatchObject({ detail: 'old codex' })
  })
})

describe('realAuthCache', () => {
  it('reads a legacy flat entry as the claude entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jff-auth-'))
    const path = join(dir, 'authcheck.json')
    writeFileSync(path, JSON.stringify({ ok: true, detail: 'legacy', at: '2026-07-27T06:00:00Z' }), 'utf8')
    const file = realAuthCache(path).readAuthCache()
    expect(file?.claude).toMatchObject({ ok: true, detail: 'legacy' })
    expect(file?.codex).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a per-vendor file unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jff-auth-'))
    const path = join(dir, 'authcheck.json')
    writeFileSync(path, JSON.stringify({ claude: { ok: true, detail: 'c', at: 'x' }, codex: { ok: false, detail: 'd', at: 'y' } }), 'utf8')
    const file = realAuthCache(path).readAuthCache()
    expect(file?.claude).toMatchObject({ detail: 'c' })
    expect(file?.codex).toMatchObject({ detail: 'd' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when the file is absent', () => {
    expect(realAuthCache('/nonexistent/authcheck.json').readAuthCache()).toBeNull()
  })
})
