/**
 * A1: one job posting, one row. Raw URLs disagree between ATSes — the Ashby
 * job's identity IS its query param (?ashby_jid=…) while Greenhouse's is the
 * path with gh_src/utm_* as tracking noise. The canonical form is
 * `host/path?params` — NO scheme (http vs https is transport, not identity)
 * and NO leading `www.` (the same posting is shared both ways). Policy on
 * params: drop the KNOWN tracking set, keep everything else (identity params
 * like ashby_jid/gh_jid/jobId are thereby kept; an unknown param kept means
 * at worst a missed badge on revisit — safer than merging two different jobs
 * by over-dropping), sorted so param order can never split one job into two.
 *
 * That "safer than over-dropping" rule makes the tracking set TWO-TIERED.
 * `utm_*` is a universal convention and `gh_src` is Greenhouse's own source
 * param, so both drop GLOBALLY — nowhere are they a posting's identity.
 * `ref`/`source` are generic enough that some site could plausibly use them AS
 * the identity, and over-dropping there is not a missed badge but silent
 * corruption: two different jobs would canonicalize to one string, collide on
 * UNIQUE(canonical_url) and the second mark would overwrite the first row. So
 * they drop only on hosts we KNOW to be an ATS, where they cannot be identity;
 * everywhere else they are kept and we pay the cheap cost (a missed badge).
 * Accepted residual: a company running an ATS on its OWN domain
 * (trmlabs.com/careers?ashby_jid=…) is not a listed host, so ref/source are
 * kept there — a missed badge, never corruption. Deliberate.
 */

/** Hosts where ref/source are known to be tracking, never identity.
 *  Extensible: adding an ATS is a one-line edit. Matched by domain-boundary
 *  suffix on the normalized hostname, so every subdomain is covered. */
const ATS_HOSTS = ['greenhouse.io', 'ashbyhq.com'] as const

/** `host` is already lowercased and www.-stripped. Suffix match must land on a
 *  domain boundary so `notgreenhouse.io` never counts as `greenhouse.io`. */
const isAtsHost = (host: string): boolean =>
  ATS_HOSTS.some((ats) => host === ats || host.endsWith(`.${ats}`))

const isTracking = (key: string, atsHost: boolean): boolean => {
  const k = key.toLowerCase()
  if (k.startsWith('utm_') || k === 'gh_src') return true
  return atsHost && (k === 'ref' || k === 'source')
}

export function canonicalUrl(raw: string): string {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return raw.trim() }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  let path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.replace(/\/+$/, '') : u.pathname
  if (path === '/') path = ''
  const atsHost = isAtsHost(host)
  const kept = [...u.searchParams].filter(([k]) => !isTracking(k, atsHost))
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = kept.length === 0
    ? ''
    : `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
  return `${host}${path}${query}`
}
