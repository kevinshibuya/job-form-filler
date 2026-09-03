import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string

// HOME_DIR is read at module load, so each case gets a fresh dir + fresh module.
async function loadWith(config: unknown) {
  if (config !== undefined) {
    writeFileSync(join(home, 'config.json'), JSON.stringify(config), 'utf8')
  }
  vi.resetModules()
  process.env.JFF_HOME = home
  const mod = await import('./config.js')
  return mod.loadConfig()
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jff-config-'))
})

afterEach(() => {
  delete process.env.JFF_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('loadConfig models', () => {
  it('is empty when config.json is absent', async () => {
    expect((await loadWith(undefined)).models).toEqual({})
  })

  it('is empty when models is missing', async () => {
    expect((await loadWith({ claudePath: 'claude' })).models).toEqual({})
  })

  it('is empty when models is not a plain object', async () => {
    expect((await loadWith({ models: ['gpt-5.6-sol'] })).models).toEqual({})
  })

  it('keeps a valid override', async () => {
    const cfg = await loadWith({ models: { generate: 'claude-fable-5-1' } })
    expect(cfg.models).toEqual({ generate: 'claude-fable-5-1' })
  })

  it('drops an unknown task key', async () => {
    const cfg = await loadWith({ models: { generate: 'claude-opus-5', nope: 'x' } })
    expect(cfg.models).toEqual({ generate: 'claude-opus-5' })
  })

  it('drops a non-string value', async () => {
    const cfg = await loadWith({ models: { generate: 7, mapping: 'gpt-5.6-sol' } })
    expect(cfg.models).toEqual({ mapping: 'gpt-5.6-sol' })
  })

  it('drops an empty string', async () => {
    const cfg = await loadWith({ models: { generate: '' } })
    expect(cfg.models).toEqual({})
  })

  it('leaves authCachePath non-overridable', async () => {
    const cfg = await loadWith({ authCachePath: '/tmp/hijacked.json' })
    expect(cfg.authCachePath).toBe(join(home, 'authcheck.json'))
  })
})
