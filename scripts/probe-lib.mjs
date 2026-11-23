// The pure half of the live probe (scripts/probe.mjs): its flags, the guards
// that keep real data out of the repo, the page list, the ATS of a page and the
// table. Nothing here launches a browser, spawns a process or writes a file, so
// scripts/probe.test.mjs covers it without either.

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { findAts } from '@jff/shared'
import { COUNTED_SOURCES, jobTextCounts, linkBoxCounts } from './probe-jobtext.mjs'

export class ProbeRefusal extends Error {}

export const DEFAULT_TIMEOUT_SEC = 180

/** Host requests the probe's bridge answers with an error instead of passing on.
 *  The probe scans and Fills; it never records an application or marks one
 *  applied, even on the copy of the database. */
export const DENIED_METHODS = Object.freeze(['applied.mark', 'save'])

export const HELP_TEXT = `npm run probe -- --pages <file> --resume <file> [options]

Measures the fill rate on live application pages. For each URL in the page
list it opens the page in a fresh browser with the built extension, lets the
tool Scan and Fill, and records what happened. It never submits a form and
never marks a Job posting applied.

For each page whose panel settles it also measures the job description scan:
  Job text           where the Scan's Job posting text came from: the ATS
                     module, your pick, a heuristic, or nothing found.
  Link box reads     whether the panel's link box can read the page's own
                     address. The probe types that address into the link box,
                     which fetches it once more, without cookies and without
                     running its scripts. It says how many sites serve their
                     posting text without scripts.
The table holds totals per ATS only: no page address, no employer name.

  --pages <file>     Page list: one URL per line, blank lines and # comments
                     skipped. Must be outside the repo.
  --resume <file>    The Resume the extension is seeded with. Required: the
                     run starts on a fresh browser profile, and without a
                     Resume the Onboarding gate blocks every Scan. Must be
                     outside the repo.
  --records <dir>    Where each run writes its records, in a folder named
                     after the run's start time. Must be outside the repo.
                     Default: <app-dir>/probe
  --app-dir <dir>    The app directory whose database and config the run
                     copies. The live database is only read.
                     Default: ~/.job-form-filler
  --timeout <sec>    How long one page may take to settle. Default: ${DEFAULT_TIMEOUT_SEC}
  --headed           Show the browser window.
  -h, --help         Print this and exit. Opens no browser and builds nothing.

The run builds the extension with its test seam, and rebuilds the production
extension when it ends, however it ends.`

const VALUE_FLAGS = { '--pages': 'pageList', '--resume': 'resume', '--records': 'records', '--app-dir': 'appDir', '--timeout': 'timeoutSec' }

/** Reads the probe's argv. Paths come back absolute, resolved against `cwd`. */
export function parseProbeArgs(argv, { home, cwd }) {
  const raw = {}
  let help = false
  let headed = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') { help = true; continue }
    if (arg === '--headed') { headed = true; continue }
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const key = VALUE_FLAGS[flag]
    if (key === undefined) throw new ProbeRefusal(`Unknown flag ${flag}. See npm run probe -- --help.`)
    let value
    if (eq !== -1) value = arg.slice(eq + 1)
    else {
      value = argv[i + 1]
      i++
    }
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
      throw new ProbeRefusal(`${flag} needs a value. See npm run probe -- --help.`)
    }
    raw[key] = value
  }
  const abs = (p) => (p === undefined ? null : resolve(cwd, p))
  const appDir = abs(raw.appDir) ?? join(home, '.job-form-filler')
  let timeoutSec = DEFAULT_TIMEOUT_SEC
  if (raw.timeoutSec !== undefined) {
    timeoutSec = Number(raw.timeoutSec)
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      throw new ProbeRefusal(`--timeout takes a number of seconds, not "${raw.timeoutSec}".`)
    }
  }
  return {
    help,
    headed,
    pageList: abs(raw.pageList),
    resume: abs(raw.resume),
    records: abs(raw.records) ?? join(appDir, 'probe'),
    appDir,
    timeoutSec,
  }
}

/** The real path of `path`, or of its nearest existing ancestor with the rest
 *  appended, so a records directory not made yet still resolves symlinks. */
function realish(path) {
  const rest = []
  let at = resolve(path)
  while (!existsSync(at)) {
    const up = dirname(at)
    if (up === at) break
    rest.unshift(basename(at))
    at = up
  }
  let real = at
  try { real = realpathSync(at) } catch { /* keep the resolved path */ }
  return join(real, ...rest)
}

/** True when `path` is `dir` or lies under it, after symlinks. */
export function isInsideDir(path, dir) {
  const rel = relative(realish(dir), realish(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Every reason the run must not start, worded for the maintainer. Empty when
 *  the page list, the Resume and the records directory are all acceptable. */
export function refusals({ pageList, resume, records }, repoRoot) {
  const out = []
  if (pageList == null) {
    out.push('No page list. Pass --pages <file>, a file of URLs one per line, kept outside the repo.')
  } else if (isInsideDir(pageList, repoRoot)) {
    out.push(`The page list ${pageList} is inside the repo. It names the postings you apply to, and the repo is public: keep it outside, for example under ~/.job-form-filler/.`)
  } else if (!existsSync(pageList)) {
    out.push(`The page list ${pageList} does not exist.`)
  }
  if (resume == null) {
    out.push('No Resume. Pass --resume <file>. The run starts on a fresh browser profile, and without a Resume the Onboarding gate blocks every Scan.')
  } else if (isInsideDir(resume, repoRoot)) {
    out.push(`The Resume ${resume} is inside the repo. It is your real Resume and the repo is public: keep it outside.`)
  } else if (!existsSync(resume)) {
    out.push(`The Resume ${resume} does not exist.`)
  }
  if (isInsideDir(records, repoRoot)) {
    out.push(`The records directory ${records} is inside the repo. Records hold what real pages asked and what was filled, and the repo is public: pass --records with a directory outside it.`)
  }
  return out
}

/** The URLs of a page list: one per line, blank lines and # comments skipped. */
export function parsePageList(text) {
  const urls = []
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    let url
    try { url = new URL(trimmed) } catch { url = null }
    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new ProbeRefusal(`Page list line ${index + 1} is not an http(s) URL: "${trimmed}".`)
    }
    urls.push(trimmed)
  })
  if (urls.length === 0) throw new ProbeRefusal('The page list has no URL in it.')
  return urls
}

/** Embed ids a company's own careers page carries for the board it embeds.
 *  This rule is the probe's own; the hosted boards come from the shared list of
 *  ATSes, matched on a domain boundary so notgreenhouse.io is not Greenhouse. */
const ATS_PARAMS = [['gh_jid', 'greenhouse'], ['ashby_jid', 'ashby']]

export function atsOf(raw) {
  let url
  try { url = new URL(raw) } catch { return 'other' }
  const hosted = findAts(url.hostname)
  if (hosted !== null) return hosted.id
  for (const [param, ats] of ATS_PARAMS) {
    if (url.searchParams.has(param)) return ats
  }
  return 'other'
}

/** The filled count the panel's status line states: "7 filled, …". */
export function filledFromStatus(text) {
  const m = /(\d+) filled\b/.exec(text ?? '')
  return m === null ? 0 : Number(m[1])
}

/** The median of the values that are numbers; null when none is. */
export function median(values) {
  const nums = values.filter((v) => typeof v === 'number').sort((a, b) => a - b)
  if (nums.length === 0) return null
  const mid = Math.floor(nums.length / 2)
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2
}

function rowOf(ats, pages) {
  return {
    ats,
    pages: pages.length,
    fields: pages.reduce((n, p) => n + p.fields, 0),
    filled: pages.reduce((n, p) => n + p.filled, 0),
    firstFillMs: median(pages.map((p) => p.firstFillMs)),
    settledMs: median(pages.map((p) => p.settledMs)),
    jobText: jobTextCounts(pages),
    linkBox: linkBoxCounts(pages),
  }
}

/** One row per ATS, by name, then one for all pages. A page that showed no form
 *  counts with zero Fields; a page that never filled or never settled is left
 *  out of that median. The job description measures count only the pages the
 *  probe measured, so a page whose panel never settled counts in neither. */
export function summarize(pages) {
  const byAts = new Map()
  for (const p of pages) byAts.set(p.ats, [...(byAts.get(p.ats) ?? []), p])
  const names = [...byAts.keys()].sort()
  return [...names.map((ats) => rowOf(ats, byAts.get(ats))), rowOf('all', pages)]
}

const secs = (ms) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`)
const rate = (r) => (r.fields === 0 ? '-' : `${Math.round((100 * r.filled) / r.fields)}%`)
const sources = (r) => {
  const counts = COUNTED_SOURCES.map((s) => r.jobText?.[s] ?? 0)
  return counts.every((n) => n === 0) ? '-' : counts.join('/')
}
const reads = (r) => (r.linkBox === undefined || r.linkBox.tried === 0 ? '-' : `${r.linkBox.read} of ${r.linkBox.tried}`)

export function formatTable(rows) {
  const header = ['ATS', 'Pages', 'Fields', 'Filled', 'Rate', 'First Fill', 'Nothing waiting', 'Job text ats/pick/heur/none', 'Link box reads']
  const body = rows.map((r) => [
    r.ats, String(r.pages), String(r.fields), String(r.filled), rate(r), secs(r.firstFillMs), secs(r.settledMs), sources(r), reads(r),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()
  return [line(header), ...body.map(line)].join('\n')
}
