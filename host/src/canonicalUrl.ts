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
 */
const isTracking = (key: string): boolean => {
  const k = key.toLowerCase()
  return k.startsWith('utm_') || k === 'gh_src' || k === 'ref' || k === 'source'
}

export function canonicalUrl(raw: string): string {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return raw.trim() }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  let path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.replace(/\/+$/, '') : u.pathname
  if (path === '/') path = ''
  const kept = [...u.searchParams].filter(([k]) => !isTracking(k))
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = kept.length === 0
    ? ''
    : `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
  return `${host}${path}${query}`
}
