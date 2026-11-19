import type Database from 'better-sqlite3'
import type { HostResponse } from '@jff/shared'
import type { HostConfig } from './config.js'
import { DatabaseTooNew } from './db/migrations.js'
import { openDbReadOnly } from './db/repos.js'
import { encodeMessage, FrameReader, MessageTooLarge } from './framing.js'
import { handleRaw, type HandlerDeps } from './handlers.js'
import type { ClaudeRunner } from './llm/claudeCli.js'
import type { CodexRunner } from './llm/codexCli.js'
import type { ResolvedModels } from './llm/models.js'
import { log } from './log.js'
import type { MailAccountDriver } from './mail/account.js'
import { createMailRequests } from './mail/requests.js'
import type { SecretStore } from './mail/secretStore.js'
import { selfCheck, type SelfCheckDeps } from './selfcheck.js'

/** Everything the Native host runs on. The shipped entry (index.ts) builds the
 *  real ones; a test passes its own. */
export interface HostDeps {
  config: HostConfig
  models: ResolvedModels
  /** Opens the database at a path, migrated. Throws DatabaseTooNew for a file
   *  a newer version of the tool wrote. */
  openDb: (path: string) => Database.Database
  runner: ClaudeRunner
  codex: CodexRunner
  /** The Mail account: its driver and where its secrets live. The shipped
   *  entry passes the Gmail driver and the Keychain; a test passes fakes. */
  mail: { driver: MailAccountDriver; secrets: SecretStore }
  /** The Self-check's own IO. Paths and the database's state come from here. */
  selfCheckIo: Omit<SelfCheckDeps, 'claudePath' | 'codexPath' | 'dbPath' | 'dbOk' | 'dbRefusal'>
  /** Native messaging frames in. */
  input: NodeJS.ReadableStream
  /** Native messaging frames out, and nothing else. */
  output: { write: (frame: Buffer) => unknown }
  exit: (code: number) => void
}

/**
 * Opens the database, then answers each frame on `input` with one on `output`,
 * one request at a time, until `input` ends. A database a newer version of the
 * tool wrote is refused, and the host stays up: the Self-check says why and
 * every other request answers the same reason, so the Side panel shows it
 * instead of an unreachable Native host.
 */
export function startHost(deps: HostDeps): void {
  const { config, output } = deps
  const { db, refusal } = openOrRefuse(deps.openDb, config.dbPath)

  const handlerDeps: HandlerDeps = {
    db, runner: deps.runner, codex: deps.codex, config, models: deps.models,
    mail: createMailRequests(deps.mail),
    ...(refusal === undefined ? {} : { dbRefusal: refusal }),
    selfCheckFn: () => selfCheck({
      ...deps.selfCheckIo,
      claudePath: config.claudePath,
      codexPath: config.codexPath,
      dbPath: config.dbPath,
      dbOk: () => { try { db.prepare('SELECT 1').get(); return true } catch { return false } },
      ...(refusal === undefined ? {} : { dbRefusal: refusal }),
    }),
  }

  const write = (res: HostResponse): void => {
    try {
      output.write(encodeMessage(res))
    } catch (e) {
      if (e instanceof MessageTooLarge) {
        output.write(encodeMessage({
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

  deps.input.on('data', (chunk: Buffer) => {
    for (const raw of reader.push(chunk)) {
      queue = queue.then(async () => { write(await handleRaw(handlerDeps, raw)) })
    }
  })
  deps.input.on('end', () => { log('info', 'stdin closed, exiting'); deps.exit(0) })
  log('info', 'host started', { dbPath: config.dbPath, claudePath: config.claudePath, refused: refusal !== undefined })
}

function openOrRefuse(
  open: HostDeps['openDb'],
  path: string,
): { db: Database.Database; refusal?: string } {
  try {
    return { db: open(path) }
  } catch (e) {
    if (!(e instanceof DatabaseTooNew)) throw e
    log('error', 'database refused', { path, found: e.found, known: e.known })
    return { db: openDbReadOnly(path), refusal: e.message }
  }
}
