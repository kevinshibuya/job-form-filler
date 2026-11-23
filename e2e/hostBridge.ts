import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HOST_ENTRY = resolve(here, '../host/dist/index.js')
/** The test-only entry: the built host with the fake Mail account driver and
 *  the fake secret store. It sits outside host/dist. */
const FAKE_MAIL_ENTRY = resolve(here, '../host/testing/jffFakeMail/host.mjs')
/** Written by the test-only entry into the host's home; the names match it. */
const FAKE_MAIL_SENT = 'jff-fake-mail-sent.jsonl'
const FAKE_MAIL_NET = 'jff-fake-mail-net.log'
const FAKE_BIN = resolve(here, 'bin')

/** One email the fake Mail account driver sent, as the test-only entry wrote it down. */
export interface FakeSentEmail {
  account: string
  from: { address: string; displayName: string }
  to: string
  subject: string
  body: string
  attachment: { name: string; mimeType: string; dataBase64: string }
}

export interface HostChild {
  request(req: { requestId: string; method: string; params: unknown }): Promise<unknown>
  dbPath: string
  home: string
  stderr: string[]
  /** Lets a Mapping reply held by `holdMapping` go. A no-op otherwise. */
  releaseMapping(): void
  /** How many Option pick prompts the stand-in model has received. */
  picks(): number
  /** With `fakeMail`: every email the fake Mail account driver sent. */
  sentMail(): FakeSentEmail[]
  /** With `fakeMail`: every network call the host process tried, all refused. */
  networkCalls(): string[]
  stop(): Promise<void>
}

/** A file's non-empty lines, none when it does not exist. */
function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l !== '') : []
}

/** Same 4-byte little-endian framing Chrome uses. */
function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.byteLength, 0)
  return Buffer.concat([head, body])
}

export async function startHost(
  opts: {
    mode?: string; codexMode?: string; holdMapping?: boolean; pick?: string
    /** The Apply address pick answers the first address containing this. */
    address?: string
    /** Start the host from the test-only entry with the fake Mail account. */
    fakeMail?: boolean
  } = {},
): Promise<HostChild> {
  const home = await mkdtemp(join(tmpdir(), 'jff-home-'))
  // The fake codex appends a line here for every Option pick it receives, and
  // answers the pick with the first Option containing `opts.pick`.
  const pickLog = join(home, 'picks.log')
  // The fake codex polls for this file before it answers a Mapping call.
  const releaseFile = join(home, 'release-mapping')
  // The host reads config.json out of JFF_HOME; point claudePath at the fake CLI
  // so nothing in this suite can reach a real `claude` (or a real network).
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    claudePath: join(FAKE_BIN, 'claude'),
    codexPath: join(FAKE_BIN, 'codex'),
    dbPath: join(home, 'db.sqlite'),
    // Mapping and the Option pick run on Claude by default (host/src/llm/models.ts),
    // but their stand-in behaviours (the held reply, the rate limit, the canned
    // pick) live in the fake codex. A gpt id routes those two tasks back to it.
    models: { mapping: 'gpt-6-luna', optionPick: 'gpt-6-luna' },
  }))

  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [opts.fakeMail === true ? FAKE_MAIL_ENTRY : HOST_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JFF_HOME: home,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      JFF_FAKE_CLAUDE_MODE: opts.mode ?? 'ok',
      JFF_FAKE_CODEX_MODE: opts.codexMode ?? 'ok',
      JFF_FAKE_CODEX_HOLD: opts.holdMapping === true ? releaseFile : '',
      JFF_FAKE_CODEX_PICK: opts.pick ?? '',
      JFF_FAKE_CODEX_PICK_LOG: pickLog,
      JFF_FAKE_CODEX_ADDRESS: opts.address ?? '',
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
    releaseMapping() { writeFileSync(releaseFile, '') },
    picks() { return existsSync(pickLog) ? readFileSync(pickLog, 'utf8').split('\n').filter((l) => l !== '').length : 0 },
    sentMail() { return lines(join(home, FAKE_MAIL_SENT)).map((l) => JSON.parse(l) as FakeSentEmail) },
    networkCalls() { return lines(join(home, FAKE_MAIL_NET)) },
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
