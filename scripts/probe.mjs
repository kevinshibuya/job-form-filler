#!/usr/bin/env node
// The live probe: `npm run probe -- --help`. A manual tool, not a test. Nothing
// in `npm test`, `npm run smoke`, `npm run verify` or CI runs it, because live
// postings expire and no gate may depend on a live site.
//
// For each page of the page list it opens the page in a fresh Chromium with the
// unpacked extension, opens the panel bound to that tab (the panel Scans on
// open and Fills what it can on its own), and watches the panel until no row is
// waiting. Once the panel settles, it reads where the Scan's Job posting text
// came from, then types the page's own address into the panel's link box and
// reads what the link gave (scripts/probe-jobtext.mjs). It clicks nothing on
// the page, so no form is submitted, and its host
// bridge refuses Mark applied and Save answers outright. The Native host runs
// on a copy of the user's database; the live file is opened read-only, once,
// to copy it, and its hash is checked before and after the run.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  atsOf, DENIED_METHODS, filledFromStatus, formatTable, HELP_TEXT, parsePageList, parseProbeArgs, ProbeRefusal, refusals, summarize,
} from './probe-lib.mjs'
import { jobTextOf, LINK_BOX_WAIT_MS, linkBoxOf, readJobTextLine, readLinkBox } from './probe-jobtext.mjs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXT_DIST = join(REPO, 'extension', 'dist')
const HOST_ENTRY = join(REPO, 'host', 'dist', 'index.js')

/** Status kinds after which the panel does nothing more on its own. */
const SETTLED = new Set(['done', 'empty', 'captcha', 'failed', 'action_failed'])
const POLL_MS = 100
const PAGE_LOAD_MS = 60_000
const NETWORK_IDLE_MS = 10_000

const say = (msg) => process.stderr.write(`${msg}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/** `npm run build`, its output on stderr so stdout carries only the table. */
function build(seam) {
  const env = { ...process.env }
  if (seam) env.JFF_TEST_SEAM = '1'
  else delete env.JFF_TEST_SEAM
  say(seam ? 'Building the extension with its test seam…' : 'Rebuilding the production extension…')
  const r = spawnSync('npm', ['run', 'build'], { cwd: REPO, env, stdio: ['ignore', 2, 2] })
  return r.status === 0
}

/** Every file under extension/dist that still carries the test seam. */
function seamFiles() {
  if (!existsSync(EXT_DIST)) return []
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (readFileSync(path).includes('jffFakeHost')) hits.push(path)
    }
  }
  walk(EXT_DIST)
  return hits
}

/** The live config, or {} when the app directory has none. */
function readLiveConfig(appDir) {
  const path = join(appDir, 'config.json')
  if (!existsSync(path)) return {}
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8'))
    return cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {}
  } catch (e) {
    throw new ProbeRefusal(`${path} is not valid JSON: ${e.message}`)
  }
}

/** Copies the live database through SQLite's backup API on a read-only
 *  connection: a consistent copy, WAL included, and no write to the live file. */
async function copyDatabase(liveDb, copyPath) {
  const { default: Database } = await import('better-sqlite3')
  const live = new Database(liveDb, { readonly: true, fileMustExist: true })
  try { await live.backup(copyPath) } finally { live.close() }
}

/** A Native host child on the run's home, framed the way Chrome frames it. */
function startHost(home, logPath) {
  const child = spawn(process.execPath, [HOST_ENTRY], {
    cwd: home,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, JFF_HOME: home },
  })
  child.stderr.on('data', (d) => appendFileSync(logPath, d))
  const pending = new Map()
  let buf = Buffer.alloc(0)
  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.byteLength >= 4) {
      const len = buf.readUInt32LE(0)
      if (buf.byteLength < 4 + len) break
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'))
      buf = buf.subarray(4 + len)
      pending.get(msg.requestId)?.(msg)
      pending.delete(msg.requestId)
    }
  })
  let closed = false
  child.on('close', (code) => {
    closed = true
    for (const [requestId, settle] of pending) {
      settle({ requestId, ok: false, error: { kind: 'unreachable', message: `host exited with code ${String(code)}` } })
    }
    pending.clear()
  })
  return {
    request(req) {
      if (closed) return Promise.resolve({ requestId: req.requestId, ok: false, error: { kind: 'unreachable', message: 'host is not running' } })
      return new Promise((settle) => {
        pending.set(req.requestId, settle)
        const body = Buffer.from(JSON.stringify(req), 'utf8')
        const head = Buffer.alloc(4)
        head.writeUInt32LE(body.byteLength, 0)
        child.stdin.write(Buffer.concat([head, body]))
      })
    },
    stop() {
      if (closed) return Promise.resolve()
      child.stdin.end()
      return new Promise((r) => {
        const kill = setTimeout(() => child.kill('SIGKILL'), 5_000)
        child.on('close', () => { clearTimeout(kill); r() })
      })
    },
  }
}

async function launchBrowser(headed) {
  const { chromium } = await import('@playwright/test')
  const profile = mkdtempSync(join(tmpdir(), 'jff-probe-profile-'))
  // channel 'chromium' is the new headless mode, which loads extensions.
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !headed,
    args: [`--disable-extensions-except=${EXT_DIST}`, `--load-extension=${EXT_DIST}`, '--mute-audio'],
  })
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(sw.url()).host
  return {
    context,
    extensionId,
    close: async () => {
      await context.close().catch(() => {})
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

function panelUrl(extensionId, query) {
  // The manifest declares no panel: the page keeps its source path (vite.config.ts).
  return `chrome-extension://${extensionId}/src/panel/index.html${query}`
}

const MIME = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }

/** Stores the Resume where the panel reads it, as the browser tests seed
 *  theirs: IndexedDB `jff`/`resume`, key `current`, from an extension-origin
 *  page that does not mount the panel. A PDF goes in without its text, so the
 *  panel extracts it the way it does a legacy upload; any other file stores
 *  `text: null`, as an upload of it would. */
async function seedResume(browser, file) {
  const name = basename(file)
  const mimeType = MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
  const record = { name, mimeType, dataBase64: readFileSync(file).toString('base64') }
  if (mimeType !== 'application/pdf') record.text = null
  const page = await browser.context.newPage()
  try {
    await page.goto(`chrome-extension://${browser.extensionId}/manifest.json`)
    await page.evaluate((rec) => new Promise((ok, fail) => {
      const open = indexedDB.open('jff', 1)
      open.onupgradeneeded = () => { open.result.createObjectStore('resume') }
      open.onerror = () => fail(new Error('indexedDB.open failed'))
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('resume', 'readwrite')
        tx.objectStore('resume').put(rec, 'current')
        tx.onerror = () => fail(new Error('resume put failed'))
        tx.oncomplete = () => { db.close(); ok() }
      }
    }), record)
  } finally {
    await page.close()
  }
}

/** `chrome.tabs` exists only in an extension context, so the lookup runs on an
 *  extension-origin page that does not mount the panel. */
async function tabIdFor(browser, url) {
  const lookup = await browser.context.newPage()
  try {
    await lookup.goto(`chrome-extension://${browser.extensionId}/manifest.json`)
    return await lookup.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({})
      const bare = (x) => (x ?? '').split('#')[0]
      return (tabs.find((t) => t.url === u) ?? tabs.find((t) => bare(t.url) === bare(u)))?.id ?? null
    }, url)
  } finally {
    await lookup.close()
  }
}

/** What the panel shows right now: its status, its rows, and the gate. */
function readPanel() {
  const status = document.querySelector('[data-jff-status]')
  const list = document.querySelector('[data-jff-rows] > ul')
  const rows = list === null ? [] : [...list.children]
  return {
    onboarding: document.querySelector('[data-jff-onboarding]') !== null,
    kind: status?.getAttribute('data-jff-status') ?? null,
    text: status?.textContent ?? '',
    waiting: rows.filter((r) => r.hasAttribute('data-jff-waiting')).length,
    rows: rows.map((r) => ({
      tier: r.getAttribute('data-jff-tier') ?? (r.hasAttribute('data-jff-waiting') ? 'waiting' : null),
      label: (r.innerText ?? '').split('\n')[0].trim().slice(0, 200),
    })),
  }
}

/** The link box's answer to the page's own address: typed and read in the
 *  panel, never on the page. Null when it gave neither a text nor its failure
 *  message in time. */
async function measureLinkBox(panel, url) {
  await panel.fill('[data-jff-link] input', url)
  await panel.click('[data-jff-link] button')
  const t0 = Date.now()
  while (Date.now() - t0 < LINK_BOX_WAIT_MS) {
    await sleep(POLL_MS)
    const answer = linkBoxOf(await panel.evaluate(readLinkBox))
    if (answer !== null) return answer
  }
  return null
}

/** One page: open it, open the panel on it, and time the Scan until nothing
 *  is waiting. A page whose panel settled then gets the job description
 *  measures. Any failure is recorded on the page and the run goes on. */
async function probePage(browser, host, url, timeoutMs) {
  const rec = {
    url, ats: atsOf(url), outcome: 'error', fields: 0, filled: 0,
    firstFillMs: null, settledMs: null, status: '', rows: [], denied: [], error: null,
    jobText: null, linkBox: null, linkBoxError: null,
  }
  let target = null
  let panel = null
  try {
    target = await browser.context.newPage()
    await target.goto(url, { waitUntil: 'load', timeout: PAGE_LOAD_MS })
    await target.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {})
    const tabId = await tabIdFor(browser, target.url())
    if (tabId === null) throw new Error(`no tab found for ${target.url()}`)

    panel = await browser.context.newPage()
    await panel.exposeFunction('__jffHostBridge', (req) => {
      if (DENIED_METHODS.includes(req.method)) {
        rec.denied.push(req.method)
        return { requestId: req.requestId, ok: false, error: { kind: 'bad_request', message: 'The probe never sends this request.' } }
      }
      return host.request(req)
    })
    // The panel Scans on open; this is the Scan's start.
    const t0 = Date.now()
    await panel.goto(panelUrl(browser.extensionId, `?jffFakeHost=1&tabId=${tabId}`))
    let seen = null
    // The highest count seen: a failed Mapping replaces the counts line with
    // the error, and what the first step filled is still on the page.
    let filled = 0
    while (Date.now() - t0 < timeoutMs) {
      seen = await panel.evaluate(readPanel)
      if (seen.onboarding) break
      filled = Math.max(filled, filledFromStatus(seen.text))
      if (rec.firstFillMs === null && filled > 0) rec.firstFillMs = Date.now() - t0
      if (SETTLED.has(seen.kind) && seen.waiting === 0) { rec.settledMs = Date.now() - t0; break }
      await sleep(POLL_MS)
    }
    rec.outcome = seen?.onboarding ? 'onboarding' : rec.settledMs !== null ? seen.kind : 'timeout'
    rec.status = seen?.text ?? ''
    rec.rows = seen?.rows ?? []
    rec.fields = rec.rows.length
    rec.filled = filled
    if (rec.settledMs !== null) {
      // The source first: the link box replaces the Session's text when it reads one.
      rec.jobText = jobTextOf(await panel.evaluate(readJobTextLine))
      try {
        rec.linkBox = await measureLinkBox(panel, url)
      } catch (e) {
        rec.linkBoxError = e instanceof Error ? e.message.split('\n')[0] : String(e)
      }
    }
  } catch (e) {
    rec.error = e instanceof Error ? e.message.split('\n')[0] : String(e)
  } finally {
    await panel?.close().catch(() => {})
    await target?.close().catch(() => {})
  }
  return rec
}

async function main() {
  let opts
  try {
    opts = parseProbeArgs(process.argv.slice(2), { home: homedir(), cwd: process.cwd() })
  } catch (e) {
    if (e instanceof ProbeRefusal) { say(e.message); return 2 }
    throw e
  }
  if (opts.help) { process.stdout.write(`${HELP_TEXT}\n`); return 0 }

  const refused = refusals(opts, REPO)
  if (refused.length > 0) { for (const r of refused) say(r); return 2 }

  let urls, liveConfig
  try {
    urls = parsePageList(readFileSync(opts.pageList, 'utf8'))
    liveConfig = readLiveConfig(opts.appDir)
  } catch (e) {
    if (e instanceof ProbeRefusal) { say(e.message); return 2 }
    throw e
  }
  const liveDb = typeof liveConfig.dbPath === 'string' ? liveConfig.dbPath : join(opts.appDir, 'db.sqlite')
  if (!existsSync(liveDb)) {
    say(`No database at ${liveDb}. Onboard in the extension first, or pass --app-dir.`)
    return 2
  }

  const runDir = join(opts.records, stamp())
  mkdirSync(runDir, { recursive: true })
  const pagesPath = join(runDir, 'pages.jsonl')
  const home = mkdtempSync(join(tmpdir(), 'jff-probe-home-'))
  const liveHashBefore = sha256(liveDb)
  try {
    await copyDatabase(liveDb, join(home, 'db.sqlite'))
  } catch (e) {
    rmSync(home, { recursive: true, force: true })
    say(`Could not copy ${liveDb}: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
  writeFileSync(join(home, 'config.json'), JSON.stringify({ ...liveConfig, dbPath: join(home, 'db.sqlite') }, null, 2))
  say(`Records: ${runDir}`)

  let browser = null
  let host = null
  let interrupted = false
  const onSigint = () => {
    if (interrupted) process.exit(130)
    interrupted = true
    say('Interrupted: stopping, then rebuilding the production extension. Ctrl-C again to quit at once.')
    void browser?.close()
  }
  process.on('SIGINT', onSigint)

  const pages = []
  let code = 0
  try {
    if (!build(true)) throw new Error('the seam build failed')
    host = startHost(home, join(runDir, 'host.log'))
    browser = await launchBrowser(opts.headed)
    await seedResume(browser, opts.resume)
    for (const [i, url] of urls.entries()) {
      if (interrupted) break
      say(`[${i + 1}/${urls.length}] ${url}`)
      const rec = await probePage(browser, host, url, opts.timeoutSec * 1000)
      if (interrupted) break
      pages.push(rec)
      appendFileSync(pagesPath, `${JSON.stringify(rec)}\n`)
      say(`  ${rec.outcome}: ${rec.fields} Fields, ${rec.filled} filled${rec.error !== null ? ` (${rec.error})` : ''}`)
      if (rec.settledMs !== null) {
        const link = rec.linkBox === null ? 'no answer' : rec.linkBox.readable ? `${String(rec.linkBox.length)} characters` : 'nothing read'
        say(`  job text: ${rec.jobText?.source ?? 'no line'}, ${String(rec.jobText?.length ?? 0)} characters; link box: ${link}`)
      }
      if (rec.outcome === 'onboarding') {
        say('The Onboarding gate is up, so no page can be scanned: the Profile in the copied database is incomplete, or the Resume did not seed.')
        code = 1
        break
      }
    }
  } catch (e) {
    say(`Probe failed: ${e instanceof Error ? e.message : String(e)}`)
    code = 1
  } finally {
    await browser?.close()
    await host?.stop()
    rmSync(home, { recursive: true, force: true })
    if (!build(false)) {
      say('The production rebuild failed: extension/dist may still hold the seam build. Run npm run build.')
      code = 1
    }
    const left = seamFiles()
    if (left.length > 0) {
      say(`extension/dist still carries the test seam in ${left.length} file(s). Run npm run build.`)
      code = 1
    }
    process.off('SIGINT', onSigint)
  }

  if (sha256(liveDb) !== liveHashBefore) {
    say(`The live database ${liveDb} changed during the run. The probe only reads it, so something else wrote to it.`)
    code = 1
  }

  if (pages.length > 0) {
    const table = formatTable(summarize(pages))
    writeFileSync(join(runDir, 'table.txt'), `${table}\n`)
    process.stdout.write(`${table}\n`)
  }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    pageList: opts.pageList, pages: urls.length, probed: pages.length, interrupted, denied: pages.flatMap((p) => p.denied),
  }, null, 2))
  return interrupted ? 130 : code
}

main().then(
  (code) => process.exit(code),
  (e) => { say(e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(1) },
)
