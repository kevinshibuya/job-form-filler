import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HOST_ENTRY = resolve(here, '../host/dist/index.js')
const FAKE_BIN = resolve(here, 'bin')

export interface HostChild {
  request(req: { requestId: string; method: string; params: unknown }): Promise<unknown>
  dbPath: string
  home: string
  stderr: string[]
  stop(): Promise<void>
}

/** Same 4-byte little-endian framing Chrome uses. */
function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.byteLength, 0)
  return Buffer.concat([head, body])
}

export async function startHost(opts: { mode?: string; codexMode?: string } = {}): Promise<HostChild> {
  const home = await mkdtemp(join(tmpdir(), 'jff-home-'))
  // The host reads config.json out of JFF_HOME; point claudePath at the fake CLI
  // so nothing in this suite can reach a real `claude` (or a real network).
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    claudePath: join(FAKE_BIN, 'claude'),
    codexPath: join(FAKE_BIN, 'codex'),
    dbPath: join(home, 'db.sqlite'),
  }))

  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [HOST_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JFF_HOME: home,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      JFF_FAKE_CLAUDE_MODE: opts.mode ?? 'ok',
      JFF_FAKE_CODEX_MODE: opts.codexMode ?? 'ok',
    },
  })

  const stderr: string[] = []
  child.stderr.on('data', (d: Buffer) => stderr.push(d.toString('utf8')))

  const pending = new Map<string, (v: unknown) => void>()
  let buf = Buffer.alloc(0)
  child.stdout.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.byteLength < 4) break
      const len = buf.readUInt32LE(0)
      if (buf.byteLength < 4 + len) break
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) as { requestId: string }
      buf = buf.subarray(4 + len)
      pending.get(msg.requestId)?.(msg)
      pending.delete(msg.requestId)
    }
  })

  // A dead host must fail its in-flight requests LOUDLY. Left pending they would
  // hang the panel's await forever and surface as an opaque Playwright timeout
  // with no clue that the host process was the thing that died. `closed` also
  // keeps stop() from awaiting an event that has already fired.
  let closed = false
  child.on('close', (code) => {
    closed = true
    for (const [requestId, settle] of pending) {
      settle({ requestId, ok: false, error: { kind: 'unreachable', message: `host exited with code ${String(code)}` } })
    }
    pending.clear()
  })

  return {
    home,
    dbPath: join(home, 'db.sqlite'),
    stderr,
    request(req) {
      return new Promise((resolveReq) => {
        pending.set(req.requestId, resolveReq)
        child.stdin.write(encode(req))
      })
    },
    stop() {
      if (closed) return Promise.resolve()
      child.stdin.end()
      return new Promise<void>((r) => child.on('close', () => r()))
    },
  }
}
