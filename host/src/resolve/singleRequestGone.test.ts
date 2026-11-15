import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostRequestSchema, type HostRequest } from '@jff/shared'
import { openDb } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { resolveModels } from '../llm/models.js'

// Resolution runs in two requests, `resolve.first` and `resolve.mapping`. The
// single request that ran both steps in one pass is gone: the shared schema
// rejects it and the Native host answers it as a bad request.

const GONE = 'resolve'

const params = {
  epoch: 5, url: 'https://boards.greenhouse.io/acme/jobs/1', hostname: 'boards.greenhouse.io',
  company: 'Acme', jobText: 'Senior engineer wanted.',
  fields: [{
    frameId: 0, fid: 1, epoch: 5, label: 'Describe a hard bug you fixed.', name: null,
    idAttr: null, kind: 'text', options: [], required: false, visible: true,
    currentValue: null, demographic: false,
  }],
}

const claudeComplete = vi.fn(async (): Promise<unknown> => ({ draft: 'x' }))
const codexComplete = vi.fn(async (): Promise<unknown> => [{ ref: '0:1', decision: 'custom', knownKey: null, answerId: null }])
let deps: HandlerDeps

beforeEach(() => {
  claudeComplete.mockClear()
  codexComplete.mockClear()
  deps = {
    db: openDb(':memory:'),
    runner: { complete: claudeComplete } as unknown as HandlerDeps['runner'],
    codex: { complete: codexComplete } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

describe('the single resolve request is gone', () => {
  it('the shared schema rejects a resolve request', () => {
    expect(HostRequestSchema.safeParse({ requestId: crypto.randomUUID(), method: GONE, params }).success).toBe(false)
  })

  it('the shared schema still accepts resolve.first and resolve.mapping with the same params', () => {
    for (const method of ['resolve.first', 'resolve.mapping']) {
      expect(HostRequestSchema.safeParse({ requestId: crypto.randomUUID(), method, params }).success).toBe(true)
    }
  })

  it('the Native host answers a resolve request as a bad request and runs no model', async () => {
    const requestId = crypto.randomUUID()
    const r = await handleRequest(deps, { requestId, method: GONE, params } as unknown as HostRequest)
    expect(r).toMatchObject({ requestId, ok: false, error: { kind: 'bad_request' } })
    expect(codexComplete).not.toHaveBeenCalled()
    expect(claudeComplete).not.toHaveBeenCalled()
  })

  it('a repeated resolve request id is still a bad request, not a replayed success', async () => {
    const requestId = crypto.randomUUID()
    await handleRequest(deps, { requestId, method: GONE, params } as unknown as HostRequest)
    const again = await handleRequest(deps, { requestId, method: GONE, params } as unknown as HostRequest)
    expect(again).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
  })
})

describe('nothing in the repo sends or scripts a resolve request', () => {
  const root = resolvePath(fileURLToPath(new URL('.', import.meta.url)), '../../..')
  const self = fileURLToPath(import.meta.url)
  const dirs = ['host/src', 'extension/src', 'shared/src', 'e2e', 'scripts']
  const skip = new Set(['node_modules', 'dist', 'fixtures'])

  const sources = (dir: string): string[] => {
    let out: string[] = []
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return out }
    for (const name of entries) {
      if (skip.has(name)) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) out = out.concat(sources(p))
      else if (/\.(ts|tsx|mjs|js|cjs)$/.test(name) && p !== self) out.push(p)
    }
    return out
  }

  // A request built with the method, a switch arm on it, or a fake that answers it.
  const patterns = [
    /method\s*:\s*['"`]resolve['"`]/,
    /method\s*[!=]==?\s*['"`]resolve['"`]/,
    /case\s+['"`]resolve['"`]\s*:/,
    /z\.literal\(\s*['"`]resolve['"`]\s*\)/,
  ]

  it('no source file, test or fake names the resolve method', () => {
    const hits = dirs.flatMap((d) => sources(join(root, d))).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
        patterns.some((p) => p.test(line)) ? [`${relative(root, file)}:${i + 1}: ${line.trim()}`] : []))
    expect(hits).toEqual([])
  })
})
