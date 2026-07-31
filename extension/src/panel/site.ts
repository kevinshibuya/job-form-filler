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
