/** Country-code second-level labels under which the registrable domain is one
 *  label deeper (minimal suffix heuristic — full PSL is out of scope, spec S5). */
const SECOND_LEVEL: ReadonlySet<string> = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'])

/** S5: "same site" = same registrable domain. jobs.acme.com and careers.acme.com
 *  are one application (SSO hops within a company stay same-site); acme.com and
 *  okta.com are a detour worth PARKING for, not destroying. */
export function registrableDomain(url: string): string {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return '' }
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
