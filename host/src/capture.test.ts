import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { HostResponse } from '@jff/shared'
import { openDb } from './db/repos.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import { resolveModels } from './llm/models.js'

// Saving a Capture (spec #41, ticket #47), as a Native host request on an
// in-memory database. The captures folder and the private-strings file are
// handed to the handler, so every test points both at a temporary folder and
// none reads or writes the real app directory. Every offending sample is
// assembled at run time, so this file never holds a string the guard would
// refuse to commit.

vi.mock('./log.js', () => ({ log: vi.fn() }))

const homePath = ['', 'Users', 'jdoe', 'notes', 'cv.pdf'].join('/')
const realEmail = ['jane.doe', 'realcorp.io'].join('@')
const credential = `ghp_${'a1B2'.repeat(6)}`

let tmp: string
let db: Database.Database
let deps: HandlerDeps
let capturesDir: string
let privateStringsPath: string
let seq = 0

const handle = { frameId: 0, fid: 0, epoch: 3 }
const field = {
  ...handle, label: 'Full name', name: 'name', idAttr: 'name', kind: 'text', options: [],
  required: true, visible: true, currentValue: null, demographic: false,
}
const resolution = { handle, tier: 'auto', source: 'profile', key: 'fullName', reason: 'recognizer:fullName' }

function params(html: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    page: { html: `<!DOCTYPE html>\n<html><head></head><body><form><label for="name">Full name</label><input id="name">${html}</form></body></html>`, cut: false },
    ats: 'lever',
    url: 'https://jobs.lever.co/acme/123/apply',
    fields: [field],
    resolutions: [resolution],
    election: { frameId: 0, score: 4, url: 'https://jobs.lever.co/acme/123/apply' },
    frameReports: [{ frameId: 0, url: 'https://jobs.lever.co/acme/123/apply', fields: 1, error: null }],
    ...patch,
  }
}

/** One `capture.save` request, through the same parse the host's stdin runs. */
async function save(p: Record<string, unknown>): Promise<HostResponse> {
  seq += 1
  return handleRaw(deps, { requestId: `capture-${seq}-${Math.random()}`, method: 'capture.save', params: p })
}

const captures = (): string[] => (existsSync(capturesDir) ? readdirSync(capturesDir) : [])

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jff-capture-'))
  capturesDir = join(tmp, 'app', 'captures')
  privateStringsPath = join(tmp, 'private-strings.txt')
  writeFileSync(privateStringsPath, '# mine\nlovelace street\n')
  db = openDb(':memory:')
  deps = {
    db,
    runner: { complete: vi.fn() } as unknown as HandlerDeps['runner'],
    codex: { complete: vi.fn() } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: {
      claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:',
      authCachePath: join(tmp, 'auth.json'), capturesDir, privateStringsPath, models: {},
    },
    selfCheckFn: async () => { throw new Error('not in this test') },
  }
})

afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('an accepted Capture', () => {
  it('is one file under the captures folder the test supplied, and the reply names it', async () => {
    const r = await save(params('<p>Tell us about yourself</p>'))
    expect(r).toMatchObject({ ok: true })
    const path = (r as { result: { path: string } }).result.path
    expect(dirname(path)).toBe(capturesDir)
    expect(captures()).toHaveLength(1)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved).toMatchObject({ ats: 'lever', url: 'https://jobs.lever.co/acme/123/apply', fields: [field], resolutions: [resolution] })
    expect(saved.page.html).toContain('Tell us about yourself')
  })

  it('sits in a folder readable, writable and searchable by the owner only, and is readable and writable by the owner only', async () => {
    const r = await save(params('<p>Why us?</p>'))
    const path = (r as { result: { path: string } }).result.path
    expect(statSync(capturesDir).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('holds the user\'s private strings replaced', async () => {
    const r = await save(params('<p>I live on Lovelace Street, number 12</p>'))
    expect(r).toMatchObject({ ok: true })
    const text = readFileSync((r as { result: { path: string } }).result.path, 'utf8')
    expect(text.toLowerCase()).not.toContain('lovelace street')
    expect(text).toContain('I live on redacted, number 12')
  })

  it('holds real e-mail addresses and credential-shaped strings replaced', async () => {
    const r = await save(params(`<p>Write to ${realEmail}</p><p>key ${credential}</p>`))
    expect(r).toMatchObject({ ok: true })
    const text = readFileSync((r as { result: { path: string } }).result.path, 'utf8')
    expect(text).not.toContain(realEmail)
    expect(text).not.toContain(credential)
  })

  it('is saved with no private-strings file on the machine', async () => {
    rmSync(privateStringsPath)
    const r = await save(params(`<p>Write to ${realEmail}</p>`))
    expect(r).toMatchObject({ ok: true })
    expect(captures()).toHaveLength(1)
    expect(readFileSync((r as { result: { path: string } }).result.path, 'utf8')).not.toContain(realEmail)
  })
})

describe('a refused Capture writes nothing', () => {
  it('when one Field has a current Value', async () => {
    const r = await save(params('', { fields: [{ ...field, currentValue: 'Ada Lovelace' }] }))
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect(captures()).toEqual([])
  })

  it('when a Resolution carries a sixth key', async () => {
    const r = await save(params('', { resolutions: [{ ...resolution, candidates: ['Ada Lovelace'] }] }))
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect((r as { error: { message: string } }).error.message).toContain('candidates')
    expect(captures()).toEqual([])
  })

  it('when the check still finds something replacement does not cover, such as a home-directory path', async () => {
    const r = await save(params(`<p>Saved from ${homePath}</p>`))
    expect(r).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    expect((r as { error: { message: string } }).error.message).toContain('home-path')
    expect((r as { error: { message: string } }).error.message).not.toContain('jdoe')
    expect(captures()).toEqual([])
  })
})
