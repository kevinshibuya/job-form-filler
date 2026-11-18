// The private-strings rules (spec #41): what finds and replaces a private
// string, a home-directory path, a real e-mail address and a credential-shaped
// string. The guard (scripts/check-private.mjs), the fixture command
// (scripts/sanitize-capture.mjs) and the Native host all call this one file.
//
// It is plain JavaScript imported as source, never built, because the guard
// runs in a fresh clone with nothing installed and nothing built, as CI and the
// git hooks run it. It is pure: it reads no file, and the user's private
// strings are handed to it. Reading the private-strings file stays with the
// callers that run in Node.

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
// Google's, last: an OAuth access token (`ya29.`), a refresh token (`1//`), a
// client secret (`GOCSPX-`) and a client id (`<project number>-<id>.apps.googleusercontent.com`).
export const SECRET =
  /sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_.-]{20,}|(?<![0-9A-Za-z])1\/\/[0-9A-Za-z_-]{20,}|GOCSPX-[0-9A-Za-z_-]{20,}|[0-9]{6,}-[0-9a-z]{20,}\.apps\.googleusercontent\.com/g

/** True for an address on a test domain, or one the allowlist names. */
export function emailAllowed(address) {
  // endsWith, since JSON-escaped markup glues `>` onto the local part.
  if ([...ALLOWED_LITERALS].some((allowed) => address.endsWith(allowed))) return true
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase()
  if (ASSET_SUFFIX.test(domain)) return true // icon@2x.png is a file, not a mailbox
  return ALLOWED_EMAIL_DOMAINS.some((allowed) => allowed.test(domain))
}

/** A private-strings file's entries, lower-cased: one per line, blanks and `#` lines skipped. */
export function parseDenylist(text) {
  return text
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `text` with every denylist entry, real e-mail address and credential replaced. */
export function redactPrivate(text, denylist = []) {
  let out = text
  for (const entry of denylist) out = out.replace(new RegExp(escapeRegExp(entry), 'gi'), 'redacted')
  out = out.replace(EMAIL, (address) => (emailAllowed(address) ? address : 'someone@example.com'))
  return out.replace(SECRET, (key) => (ALLOWED_LITERALS.has(key) ? key : 'REDACTED-KEY'))
}
