import { ATS_LIST, findAts } from '@jff/shared'

/** An ATS's own name, never the employer behind a Job posting. */
const isAtsName = (name: string): boolean =>
  ATS_LIST.some((ats) => ats.name.toLowerCase() === name.toLowerCase())

/**
 * Best-effort ONE-SHOT guess shown in an editable field; the user's edit always
 * wins downstream. Title "… at Company" first, then a company-owned host's
 * second-level domain. A host on the shared list of ATSes, an ATS's own name,
 * IPs and localhost yield null.
 */
export function guessCompany(title: string, hostname: string): string | null {
  const host = hostname.toLowerCase()
  const onAts = findAts(host) !== null

  const at = /\bat ([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*)\s*$/.exec(title)
  const fromTitle = at?.[1]?.trim()
  if (fromTitle !== undefined && !isAtsName(fromTitle)) return fromTitle

  if (onAts || /^[\d.]+$/.test(host) || host === 'localhost') return null
  const parts = host.replace(/^www\./, '').split('.')
  if (parts.length < 2) return null
  const sld = parts[parts.length - 2]!
  if (sld === '') return null
  return sld.charAt(0).toUpperCase() + sld.slice(1)
}
