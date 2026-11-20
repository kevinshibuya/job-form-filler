/* eslint-disable no-restricted-properties -- this is the ONE file allowed to touch stdout: it hands it to startHost */
// The shipped entry: builds the real dependencies and starts the Native host.
// Everything else lives in startHost.ts, which tests drive with their own.
import { loadConfig } from './config.js'
import { openDb } from './db/repos.js'
import { createClaudeRunner } from './llm/claudeCli.js'
import { createCodexRunner } from './llm/codexCli.js'
import { createModelRoutedRunner } from './llm/routedRunner.js'
import { resolveModels } from './llm/models.js'
import { log } from './log.js'
import { createGmailDriver } from './mail/gmail.js'
import { realHttp } from './mail/net.js'
import { createKeychainStore } from './mail/secretStore.js'
import { realAuthCache, realFileExists, realProbeAuth, realProbeCodexAuth } from './selfcheck.js'
import { startHost } from './startHost.js'

process.on('uncaughtException', (e) => { log('error', 'uncaught', { message: String(e) }) })

const config = loadConfig()
const models = resolveModels(config.models)
const claude = createClaudeRunner({ claudePath: config.claudePath })

startHost({
  config,
  models,
  openDb: (path) => openDb(path),
  runner: claude,
  // The structured tasks: each call goes to the CLI its model belongs to.
  codex: createModelRoutedRunner(claude, createCodexRunner({ codexPath: config.codexPath })),
  mail: { driver: createGmailDriver({ http: realHttp }), secrets: createKeychainStore() },
  selfCheckIo: {
    fileExists: realFileExists,
    probeAuth: realProbeAuth(config.claudePath, models.claudeAuthProbe),
    probeCodexAuth: realProbeCodexAuth(config.codexPath, models.codexAuthProbe),
    now: () => new Date(),
    ...realAuthCache(config.authCachePath),
  },
  input: process.stdin,
  output: process.stdout,
  exit: (code) => process.exit(code),
})
