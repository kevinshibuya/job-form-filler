import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import DatabaseCtor from 'better-sqlite3'
import type { HostResponse } from '@jff/shared'
import { MIGRATIONS } from './db/migrations.js'
import { getProfile, openDb, setProfile } from './db/repos.js'
import { encodeMessage, FrameReader } from './framing.js'
import { resolveModels } from './llm/models.js'
import { startHost, type HostDeps } from './startHost.js'

// The host log is a file under the real home directory: no test writes to it.
vi.mock('./log.js', () => ({ log: vi.fn() }))

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '../..')
const VITE_NODE = join(REPO, 'node_modules/vite-node/vite-node.mjs')
const ENTRY = resolve(here, 'index.ts')

const dirs: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(() => {
  for (const c of children.splice(0)) c.kill()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jff-host-'))
  dirs.push(dir)
  return dir
}

/** A database file a newer version of the tool wrote: one version past the
 *  last migration this Native host knows, with a Profile row in it. */
function newerDb(path: string): void {
  const db = openDb(path)
  setProfile(db, { email: 'ada@example.com' })
  db.pragma(`user_version = ${MIGRATIONS.length + 1}`)
  db.close()
}

function profileOnDisk(path: string): Record<string, string> {
  const db = new DatabaseCtor(path, { readonly: true })
  try { return getProfile(db) } finally { db.close() }
}

const selfCheckReq = { requestId: 'sc-1', method: 'selfCheck', params: {} }
const writeReq = { requestId: 'w-1', method: 'profile.set', params: { values: { firstName: 'Ada' } } }

/** startHost on in-memory streams, its dependencies faked except the database. */
function startInProcess(dbPath: string): {
  send: (req: unknown) => Promise<HostResponse>
  exit: ReturnType<typeof vi.fn>
  input: PassThrough
} {
  const input = new PassThrough()
  const reader = new FrameReader()
  const waiting = new Map<string, (r: HostResponse) => void>()
  const exit = vi.fn()
  const deps: HostDeps = {
    config: {
      claudePath: '/nonexistent/claude', codexPath: '/nonexistent/codex', projectsPaths: [], dbPath,
      authCachePath: '/nonexistent/auth.json', capturesDir: '/nonexistent/captures',
      privateStringsPath: '/nonexistent/private-strings.txt', models: {},
    },
    models: resolveModels({}),
    openDb: (path) => openDb(path),
    runner: { complete: vi.fn() } as unknown as HostDeps['runner'],
    codex: { complete: vi.fn() } as unknown as HostDeps['codex'],
    selfCheckIo: {
      fileExists: () => false,
      readAuthCache: () => null,
      writeAuthCache: () => {},
      probeAuth: async () => ({ ok: true, detail: 'logged in' }),
      probeCodexAuth: async () => ({ ok: true, detail: 'logged in' }),
      now: () => new Date('2026-11-18T12:00:00Z'),
    },
    input,
    output: {
      write: (frame: Buffer) => {
        for (const msg of reader.push(frame)) {
          const res = msg as HostResponse
          waiting.get(res.requestId)?.(res)
        }
      },
    },
    exit,
  }
  startHost(deps)
  return {
    input,
    exit,
    send: (req) => new Promise((ok) => {
      waiting.set((req as { requestId: string }).requestId, ok)
      input.write(encodeMessage(req))
    }),
  }
}

describe('startHost', () => {
  it('answers requests from its input on its output, against the database it opened', async () => {
    const dbPath = join(tempHome(), 'db.sqlite')
    const host = startInProcess(dbPath)
    const res = await host.send(writeReq)
    expect(res).toMatchObject({ requestId: 'w-1', ok: true, result: { firstName: 'Ada' } })
    expect(profileOnDisk(dbPath)).toEqual({ firstName: 'Ada' })

    host.input.end()
    await vi.waitFor(() => expect(host.exit).toHaveBeenCalledWith(0))
  })

  it('stays up on a database from a newer version: the Self-check says why and a write is refused', async () => {
    const dbPath = join(tempHome(), 'db.sqlite')
    newerDb(dbPath)
    const host = startInProcess(dbPath)

    const check = await host.send(selfCheckReq)
    expect(check).toMatchObject({ ok: true, result: { db: { ok: false, path: dbPath } } })
    expect((check as { result: { db: { detail: string } } }).result.db.detail).toMatch(/newer version of the tool/)

    const write = await host.send(writeReq)
    expect(write).toMatchObject({ ok: false, error: { kind: 'db' } })
    expect((write as { error: { message: string } }).error.message).toMatch(/newer version of the tool/)
    expect(profileOnDisk(dbPath)).toEqual({ email: 'ada@example.com' })
    expect(host.exit).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------ the shipped entry, live */

function spawnEntry(home: string): {
  child: ChildProcessWithoutNullStreams
  request: (req: unknown) => Promise<HostResponse>
} {
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    claudePath: join(home, 'no-claude'), codexPath: join(home, 'no-codex'), dbPath: join(home, 'db.sqlite'),
  }))
  // HOME too: the host log lives under the home directory.
  const child = spawn(process.execPath, [VITE_NODE, ENTRY], {
    cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, JFF_HOME: home, HOME: home },
  })
  children.push(child)
  const reader = new FrameReader()
  const waiting = new Map<string, (r: HostResponse) => void>()
  child.stdout.on('data', (chunk: Buffer) => {
    for (const msg of reader.push(chunk)) {
      const res = msg as HostResponse
      waiting.get(res.requestId)?.(res)
    }
  })
  return {
    child,
    request: (req) => new Promise((ok) => {
      waiting.set((req as { requestId: string }).requestId, ok)
      child.stdin.write(encodeMessage(req))
    }),
  }
}

describe('the Native host process', () => {
  it('stays up on a database from a newer version, answers the Self-check and refuses a write', async () => {
    const home = tempHome()
    const dbPath = join(home, 'db.sqlite')
    newerDb(dbPath)
    const { child, request } = spawnEntry(home)

    const check = await request(selfCheckReq)
    expect(check).toMatchObject({ ok: true, result: { db: { ok: false, path: dbPath } } })
    expect((check as { result: { db: { detail: string } } }).result.db.detail).toMatch(/newer version of the tool/)

    const write = await request(writeReq)
    expect(write).toMatchObject({ ok: false, error: { kind: 'db' } })
    expect(child.exitCode).toBeNull()
    expect(profileOnDisk(dbPath)).toEqual({ email: 'ada@example.com' })

    const exited = new Promise<number | null>((ok) => child.on('exit', ok))
    child.stdin.end()
    expect(await exited).toBe(0)
  }, 60_000)
})
