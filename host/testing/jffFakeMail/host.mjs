// Test-only. The Native host's entry for the browser test of an Application
// email (spec #66): the shipped entry's wiring, with the fake Mail account
// driver and the fake secret store in place of Gmail and the Keychain. It runs
// the built host (host/dist) unchanged and passes the fakes to its start
// function, so the product gains no test-only switch. It lives under
// host/testing, outside the host's build, and its path holds the marker the
// build proof greps host/dist for.
//
// What the test reads back, written into JFF_HOME:
//   jff-fake-mail-sent.jsonl  one line per email the fake driver sent, its
//                             attachment's bytes in base64
//   jff-fake-mail-net.log     one line per network call the process tried;
//                             every one is refused, so nothing reaches Google
// The test runs this file after `npm run build`; host/dist must exist.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME_DIR, loadConfig } from '../../dist/config.js'
import { openDb } from '../../dist/db/repos.js'
import { createClaudeRunner } from '../../dist/llm/claudeCli.js'
import { createCodexRunner } from '../../dist/llm/codexCli.js'
import { resolveModels } from '../../dist/llm/models.js'
import { log } from '../../dist/log.js'
import { realAuthCache, realFileExists, realProbeAuth, realProbeCodexAuth } from '../../dist/selfcheck.js'
import { startHost } from '../../dist/startHost.js'
import { createFakeMailDriver } from './driver.mjs'
import { createFakeSecretStore } from './secretStore.mjs'

export const SENT_FILE = 'jff-fake-mail-sent.jsonl'
export const NET_FILE = 'jff-fake-mail-net.log'

// No call leaves this process: the fake driver makes none, and any other
// that tries is written down and refused.
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  appendFileSync(join(HOME_DIR, NET_FILE), `${url}\n`, 'utf8')
  throw new Error(`the test-only host refused a network call to ${url}`)
}

process.on('uncaughtException', (e) => { log('error', 'uncaught', { message: String(e) }) })

const config = loadConfig()
const models = resolveModels(config.models)

const driver = createFakeMailDriver({
  onSend: (account, email) => {
    const line = {
      account: account.address,
      from: email.from,
      to: email.to,
      subject: email.subject,
      body: email.body,
      attachment: { name: email.attachment.name, mimeType: email.attachment.mimeType, dataBase64: email.attachment.data.toString('base64') },
    }
    appendFileSync(join(HOME_DIR, SENT_FILE), `${JSON.stringify(line)}\n`, 'utf8')
  },
})

log('info', 'test-only entry: fake Mail account driver and secret store')

startHost({
  config,
  models,
  openDb: (path) => openDb(path),
  runner: createClaudeRunner({ claudePath: config.claudePath }),
  codex: createCodexRunner({ codexPath: config.codexPath }),
  mail: { driver, secrets: createFakeSecretStore() },
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
