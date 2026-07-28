import { describe, it, expect, vi } from 'vitest'
import { selfCheck } from './selfcheck.js'

const base = {
  claudePath: '/opt/homebrew/bin/claude',
  dbPath: '/tmp/jff-test.sqlite',
  fileExists: () => true,
  dbOk: () => true,
  readAuthCache: () => null,
  writeAuthCache: vi.fn(),
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
      readAuthCache: () => ({ ok: true, detail: 'cached', at: '2026-07-27T06:00:00Z' }),
    })
    expect(probeAuth).not.toHaveBeenCalled()
    expect(r.auth).toEqual({ ok: true, detail: 'cached' })
  })

  it('re-probes when the cached auth result is older than 12 hours', async () => {
    const probeAuth = vi.fn(async () => ({ ok: true, detail: 'fresh' }))
    const r = await selfCheck({
      ...base, probeAuth,
      readAuthCache: () => ({ ok: true, detail: 'stale', at: '2026-07-26T06:00:00Z' }),
    })
    expect(probeAuth).toHaveBeenCalledTimes(1)
    expect(r.auth.detail).toBe('fresh')
  })

  it('never caches a failed auth probe', async () => {
    const writeAuthCache = vi.fn()
    await selfCheck({ ...base, writeAuthCache, probeAuth: async () => ({ ok: false, detail: 'not logged in' }) })
    expect(writeAuthCache).not.toHaveBeenCalled()
  })
})
