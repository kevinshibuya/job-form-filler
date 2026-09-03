/* eslint-disable no-restricted-properties -- this is the ONE file allowed to write stdout */
import { HostRequestSchema, type HostResponse } from '@jff/shared'
import { loadConfig } from './config.js'
import { openDb } from './db/repos.js'
import { encodeMessage, FrameReader, MessageTooLarge } from './framing.js'
import { createClaudeRunner } from './llm/claudeCli.js'
import { createCodexRunner } from './llm/codexCli.js'
import { handleRequest, type HandlerDeps } from './handlers.js'
import { log } from './log.js'
import { realAuthCache, realFileExists, realProbeAuth, realProbeCodexAuth, selfCheck } from './selfcheck.js'
import { resolveModels } from './llm/models.js'

const config = loadConfig()
const db = openDb(config.dbPath)
const runner = createClaudeRunner({ claudePath: config.claudePath })
const codex = createCodexRunner({ codexPath: config.codexPath })
const authCache = realAuthCache(config.authCachePath)
const models = resolveModels(config.models)

const deps: HandlerDeps = {
  db, runner, codex, config, models,
  selfCheckFn: () => selfCheck({
    claudePath: config.claudePath,
    codexPath: config.codexPath,
    dbPath: config.dbPath,
    fileExists: realFileExists,
    dbOk: () => { try { db.prepare('SELECT 1').get(); return true } catch { return false } },
    probeAuth: realProbeAuth(config.claudePath, models.claudeAuthProbe),
    probeCodexAuth: realProbeCodexAuth(config.codexPath, models.codexAuthProbe),
    now: () => new Date(),
    ...authCache,
  }),
}

function write(res: HostResponse): void {
  try {
    process.stdout.write(encodeMessage(res))
  } catch (e) {
    if (e instanceof MessageTooLarge) {
      process.stdout.write(encodeMessage({
        requestId: res.requestId, ok: false,
        error: { kind: 'process', message: 'response exceeded the 1MB cap; this method must paginate' },
      } satisfies HostResponse))
      return
    }
    log('error', 'failed to write response', { message: String(e) })
  }
}

const reader = new FrameReader()
// Serialize handling so SQLite never sees concurrent writers from one port.
let queue: Promise<void> = Promise.resolve()

process.stdin.on('data', (chunk: Buffer) => {
  for (const raw of reader.push(chunk)) {
    queue = queue.then(async () => {
      const parsed = HostRequestSchema.safeParse(raw)
      if (!parsed.success) {
        const requestId = typeof (raw as { requestId?: unknown })?.requestId === 'string'
          ? (raw as { requestId: string }).requestId : 'unknown'
        write({ requestId, ok: false, error: { kind: 'bad_request', message: parsed.error.message } })
        return
      }
      write(await handleRequest(deps, parsed.data))
    })
  }
})

process.stdin.on('end', () => { log('info', 'stdin closed, exiting'); process.exit(0) })
process.on('uncaughtException', (e) => { log('error', 'uncaught', { message: String(e) }) })
log('info', 'host started', { dbPath: config.dbPath, claudePath: config.claudePath })
