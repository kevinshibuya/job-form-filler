#!/usr/bin/env node
// Keeps personal data and credentials out of this public repo. This is a CLI:
// printing is fine.
//
//   --staged            staged added lines and the commit identity   (pre-commit)
//   --message <file>    a commit message file                        (commit-msg)
//   --pre-push <remote> the commits a push would publish             (pre-push)
//   --range <revs...>   the commits `git rev-list <revs>` names      (CI)
//   --tree              every tracked file in the working tree       (CI, audits)
//
// Generic rules catch the shapes anyone could leak: a home-directory path, an
// email on a real domain, a credential, a commit signed with a real address.
// The private denylist catches what only its owner knows: one string per line
// in ~/.job-form-filler/private-strings.txt, which never enters the repo.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Files no rule reads: lockfiles quote package authors' addresses. */
export const SKIP_PATHS = new Set(['package-lock.json'])

/** Exact strings a captured third-party page legitimately carries. */
export const ALLOWED_LITERALS = new Set([
  // Greenhouse's own browser key, served to every visitor of its public
  // application pages; earlier fixtures in this repo's history carry it.
  'AIzaSyBeoz4WOjOsy8ZJFIkkQBvL8BZQCzLplHQ',
  'git@github.com',
  'noreply@github.com',
  'noreply@anthropic.com',
])

/** A test address belongs on a domain nobody can receive mail at. */
const ALLOWED_EMAIL_DOMAINS = [/(^|\.)example\.(com|org|net)$/, /^x\.(com|dev)$/, /^b\.com$/, /^users\.noreply\.github\.com$/]

/** Placeholder account names that say nothing about a real machine. */
const ALLOWED_HOME_NAMES = new Set(['you', 'me', 'user', 'username', 'name', 'runner', 'ada'])

const ASSET_SUFFIX = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|m?js|tsx?|map|json|html)$/
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const HOME_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g
export const SECRET =
  /sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}/g
const NOREPLY_IDENTITY = /@users\.noreply\.github\.com$|^noreply@github\.com$/

/** True for an address on a test domain, or one the allowlist names. */
export function emailAllowed(address) {
  // endsWith, since JSON-escaped markup glues `\u003e` onto the local part.
  if ([...ALLOWED_LITERALS].some((allowed) => address.endsWith(allowed))) return true
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase()
  if (ASSET_SUFFIX.test(domain)) return true // icon@2x.png is a file, not a mailbox
  return ALLOWED_EMAIL_DOMAINS.some((allowed) => allowed.test(domain))
}

export function denylistPath() {
  return process.env.JFF_PRIVATE_STRINGS ?? join(homedir(), '.job-form-filler', 'private-strings.txt')
}

/** The denylist's entries, lower-cased; `null` when the file does not exist. */
export function loadDenylist(path = denylistPath()) {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.toLowerCase())
}

/** Every rule a single line breaks. A denylist hit never echoes the string. */
export function scanLine(line, denylist = []) {
  const found = []
  const lower = line.toLowerCase()
  denylist.forEach((entry, index) => {
    if (lower.includes(entry)) found.push({ rule: 'private-string', detail: `denylist entry ${index + 1}` })
  })
  for (const [match] of line.matchAll(EMAIL)) {
    if (!emailAllowed(match)) found.push({ rule: 'email', detail: match })
  }
  for (const [match, name] of line.matchAll(HOME_PATH)) {
    if (name.length > 1 && !ALLOWED_HOME_NAMES.has(name)) found.push({ rule: 'home-path', detail: match })
  }
  for (const [match] of line.matchAll(SECRET)) {
    if (!ALLOWED_LITERALS.has(match)) found.push({ rule: 'credential', detail: `${match.slice(0, 8)}…` })
  }
  return found
}

/** A commit's author or committer address must be a GitHub noreply one. */
export function scanIdentity(email) {
  return NOREPLY_IDENTITY.test(email) ? [] : [{ rule: 'identity', detail: email }]
}

/** The added lines of a unified diff, each with its file and line number. */
export function addedLines(diff) {
  const lines = []
  let file = null
  let lineNo = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw === '+++ /dev/null' ? null : raw.slice(6)
    } else if (raw.startsWith('@@')) {
      lineNo = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0)
    } else if (raw.startsWith('+') && file !== null) {
      lines.push({ file, line: lineNo, text: raw.slice(1) })
      lineNo += 1
    }
  }
  return lines
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

function scanText(text, where, denylist, findings) {
  text.split('\n').forEach((line, index) => {
    for (const hit of scanLine(line, denylist)) findings.push({ ...hit, where: `${where}:${index + 1}` })
  })
}

function scanDiff(diff, label, denylist, findings) {
  for (const { file, line, text } of addedLines(diff)) {
    if (SKIP_PATHS.has(file)) continue
    for (const hit of scanLine(text, denylist)) findings.push({ ...hit, where: `${label}${file}:${line}` })
  }
}

function scanCommit(sha, denylist, findings) {
  const short = sha.slice(0, 7)
  const [author, committer, ...message] = git('log', '-1', '--format=%ae%n%ce%n%B', sha).split('\n')
  for (const email of new Set([author, committer])) {
    for (const hit of scanIdentity(email)) findings.push({ ...hit, where: `${short} identity` })
  }
  scanText(message.join('\n'), `${short} message`, denylist, findings)
  const diff = git('show', '--format=', '-U0', '--no-color', '--diff-merges=first-parent', sha)
  scanDiff(diff, `${short} `, denylist, findings)
}

function scanTree(denylist, findings) {
  for (const file of git('ls-files', '-z').split('\0')) {
    if (file === '' || SKIP_PATHS.has(file) || !existsSync(file)) continue
    const data = readFileSync(file)
    if (data.subarray(0, 8192).includes(0)) continue // binary
    scanText(data.toString('utf8'), file, denylist, findings)
  }
}

/** The commits a push would publish, from the lines git feeds a pre-push hook. */
function pushedCommits(remote, stdin) {
  const shas = new Set()
  for (const line of stdin.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/)
    if (!localSha || /^0+$/.test(localSha)) continue // nothing pushed, or a delete
    const range = /^0+$/.test(remoteSha) ? [localSha, '--not', `--remotes=${remote}`] : [`${remoteSha}..${localSha}`]
    for (const sha of git('rev-list', ...range).split('\n')) if (sha) shas.add(sha)
  }
  return [...shas]
}

function main(argv) {
  const [mode, ...rest] = argv
  const loaded = loadDenylist()
  const denylist = loaded ?? []
  const findings = []

  if (mode === '--staged') {
    scanDiff(git('diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR'), '', denylist, findings)
    for (const ident of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      const email = /<([^>]*)>/.exec(git('var', ident))?.[1] ?? ''
      for (const hit of scanIdentity(email)) findings.push({ ...hit, where: ident })
    }
  } else if (mode === '--message') {
    const message = readFileSync(rest[0], 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('#'))
    scanText(message.join('\n'), 'commit message', denylist, findings)
  } else if (mode === '--pre-push') {
    for (const sha of pushedCommits(rest[0], readFileSync(0, 'utf8'))) scanCommit(sha, denylist, findings)
  } else if (mode === '--range') {
    for (const sha of git('rev-list', ...rest).split('\n')) if (sha) scanCommit(sha, denylist, findings)
  } else if (mode === '--tree') {
    scanTree(denylist, findings)
  } else {
    console.error('usage: check-private.mjs --staged | --message <file> | --pre-push <remote> | --range <revs...> | --tree')
    return 2
  }

  if (loaded === null && !process.env.CI) {
    console.error(`check-private: no denylist at ${denylistPath()}, so only the generic rules ran.`)
  }
  if (findings.length === 0) return 0
  console.error(`check-private: ${findings.length} finding(s). Nothing personal belongs in this repo.`)
  for (const { rule, where, detail } of findings.slice(0, 50)) console.error(`  ${rule.padEnd(14)} ${where}  ${detail}`)
  if (findings.length > 50) console.error(`  … and ${findings.length - 50} more`)
  console.error('Use the Ada Lovelace persona in tests, and keep real notes in ~/.job-form-filler/dev/.')
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
