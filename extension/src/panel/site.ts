/** Country-code second-level labels under which the registrable domain is one
 *  label deeper (minimal suffix heuristic — full PSL is out of scope, spec S5). */
const SECOND_LEVEL: ReadonlySet<string> = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'])

/** S5: "same site" = same registrable domain. jobs.acme.com and careers.acme.com
 *  are one application (SSO hops within a company stay same-site); acme.com and
 *  okta.com are a detour worth PARKING for, not destroying. */
/** An IP literal has NO registrable domain — every label is significant. Sliced
 *  by the suffix heuristic below, '127.0.0.1' becomes '0.1' and '127.0.0.1:3000'
 *  and '127.0.0.2:4000' classify as the SAME site, which silently disarms the
 *  cross-site park between two local origins. `URL.hostname` strips the port and
 *  brackets IPv6 ('[::1]'), so the bracket is the whole IPv6 test. */
function isIpLiteral(host: string): boolean {
  if (host.startsWith('[')) return true
  const octets = host.split('.')
  return octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
}

export function registrableDomain(url: string): string {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return '' }
  if (isIpLiteral(host)) return host
  const parts = host.split('.').filter((p) => p !== '')
  if (parts.length <= 2) return parts.join('.')
  const tld = parts[parts.length - 1]!
  const sld = parts[parts.length - 2]!
  const take = SECOND_LEVEL.has(sld) && tld.length === 2 ? 3 : 2
  return parts.slice(-take).join('.')
}

export function sameSite(a: string, b: string): boolean {
  const da = registrableDomain(a)
  return da !== '' && da === registrableDomain(b)
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const UUID_WHOLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The posting ids a URL carries: runs of four or more digits and UUIDs in its
 * path, and query values that are wholly one of those. A port, a mixed token
 * (an SSO code) or a slug is no id.
 */
function postingIds(url: string): Set<string> {
  let u: URL
  try { u = new URL(url) } catch { return new Set() }
  let path = u.pathname
  try { path = decodeURIComponent(path) } catch { /* the raw path still names its ids */ }
  const out = new Set<string>()
  for (const m of path.match(UUID) ?? []) out.add(m.toLowerCase())
  for (const m of path.replace(UUID, ' ').match(/\d{4,}/g) ?? []) out.add(m)
  for (const v of u.searchParams.values()) {
    const t = v.trim()
    if (/^\d{4,}$/.test(t) || UUID_WHOLE.test(t)) out.add(t.toLowerCase())
  }
  return out
}

/**
 * One application: the same site (sameSite), and not a different posting. A
 * multi-tenant ATS host is one registrable domain for every company, so two
 * URLs that both carry posting ids and share none are two postings. A step
 * that keeps the id (a confirmation page), or a URL with no id (a board list,
 * a wizard step), stays the same application.
 */
export function sameApplication(url: string, startUrl: string): boolean {
  if (!sameSite(url, startUrl)) return false
  const a = postingIds(url)
  const b = postingIds(startUrl)
  if (a.size === 0 || b.size === 0) return true
  for (const id of a) if (b.has(id)) return true
  return false
}

/** Where an application started, as a person reads it: the host and path ("jobs.acme.com/apply"), or '' when unparseable. */
export function placeOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname.replace(/\/+$/, '')}`
  } catch { return '' }
}

