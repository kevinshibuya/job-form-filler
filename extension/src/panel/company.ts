import { ATS_LIST, companyFromTitle, companySlugFrom, findAts, type AtsOrGeneric } from '@jff/shared'

/** An ATS's own name, or the first label of one of its hostnames
 *  (`ashbyhq`), never the employer behind a Job posting. */
const isAtsName = (name: string): boolean => {
  const n = name.trim().toLowerCase()
  return ATS_LIST.some((ats) => ats.name.toLowerCase() === n || ats.hosts.some((h) => h.split('.')[0] === n))
}

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

/** A slug written as words: `acme-rockets` is "Acme Rockets". */
export function slugAsWords(slug: string): string {
  return slug.split(/[-_.]+/).filter((w) => w !== '').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** What a Scan knows of the page when it guesses the Company. */
export interface CompanyPage {
  /** The Scan's ATS. */
  ats: AtsOrGeneric
  /** The tab's title. */
  title: string
  /** The tab's hostname and address. */
  hostname: string
  url: string
  /** The elected frame's address, or null with no elected frame. */
  frameUrl: string | null
}

const hostOf = (url: string | null): string => {
  if (url === null || url === '') return ''
  try { return new URL(url).hostname } catch { return '' }
}

/**
 * The Company of a Scan (spec #41): the ATS's title pattern, then the ATS's
 * address slug written as words, then `guessCompany`'s generic guess. The title
 * is the tab's. The address is the elected frame's when that frame is on the
 * ATS, and the tab's otherwise. An ATS's name is never the Company.
 */
export function guessScanCompany(page: CompanyPage): string | null {
  const ats = ATS_LIST.find((a) => a.id === page.ats)
  if (ats !== undefined) {
    const fromTitle = companyFromTitle(ats, page.title)
    if (fromTitle !== null && !isAtsName(fromTitle)) return fromTitle
    const frameOnAts = findAts(hostOf(page.frameUrl))?.id === ats.id
    const slug = companySlugFrom(ats, frameOnAts ? page.frameUrl! : page.url)
    const words = slug === null ? '' : slugAsWords(slug)
    if (words !== '' && !isAtsName(words)) return words
  }
  return guessCompany(page.title, page.hostname)
}
