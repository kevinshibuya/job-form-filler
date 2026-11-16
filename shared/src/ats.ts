/**
 * The one list of ATSes the tool knows (spec #41). The Canonical URL, the
 * Company guess and the probe read it and keep no list of their own, so adding
 * an ATS is one edit here.
 *
 * Being on this list does not mean having an ATS module: an entry with no
 * module gets the generic behaviour (see atsModule.ts).
 */

export type AtsId =
  | 'greenhouse'
  | 'ashby'
  | 'lever'
  | 'workday'
  | 'smartrecruiters'
  | 'workable'
  | 'gupy'
  | 'recruitee'
  | 'bamboohr'
  | 'icims'

/** How an ATS writes the Company into its pages. */
export interface CompanyWriting {
  /** The page title's pattern; its first group is the Company. */
  readonly titlePattern: RegExp
  /** Where the Company's slug sits in an address; its first group is the slug. */
  readonly slugPattern: RegExp
}

export interface Ats {
  readonly id: AtsId
  readonly name: string
  /** Matched on a domain boundary, so every subdomain is covered. */
  readonly hosts: readonly string[]
  /** Whether `ref`/`source` are stripped for the Canonical URL (ADR 0003). */
  readonly stripsTrackingParams: boolean
  readonly company?: CompanyWriting
}

export const ATS_LIST: readonly Ats[] = [
  {
    id: 'greenhouse',
    name: 'Greenhouse',
    hosts: ['greenhouse.io'],
    stripsTrackingParams: true,
    company: {
      titlePattern: /^Job Application for .+ at (.+)$/i,
      slugPattern: /greenhouse\.io\/(?:embed\/job_app\?for=)?([a-z0-9_-]+)/i,
    },
  },
  {
    id: 'ashby',
    name: 'Ashby',
    hosts: ['ashbyhq.com'],
    stripsTrackingParams: true,
    company: {
      titlePattern: / @ (.+)$/,
      slugPattern: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i,
    },
  },
  {
    id: 'lever',
    name: 'Lever',
    hosts: ['lever.co'],
    stripsTrackingParams: false,
    company: {
      titlePattern: /^(.+?) [-–] /,
      slugPattern: /jobs\.lever\.co\/([a-z0-9_-]+)/i,
    },
  },
  { id: 'workday', name: 'Workday', hosts: ['myworkdayjobs.com', 'workday.com'], stripsTrackingParams: false },
  { id: 'smartrecruiters', name: 'SmartRecruiters', hosts: ['smartrecruiters.com'], stripsTrackingParams: false },
  { id: 'workable', name: 'Workable', hosts: ['workable.com'], stripsTrackingParams: false },
  { id: 'gupy', name: 'Gupy', hosts: ['gupy.io'], stripsTrackingParams: false },
  { id: 'recruitee', name: 'Recruitee', hosts: ['recruitee.com'], stripsTrackingParams: false },
  { id: 'bamboohr', name: 'BambooHR', hosts: ['bamboohr.com'], stripsTrackingParams: false },
  { id: 'icims', name: 'iCIMS', hosts: ['icims.com'], stripsTrackingParams: false },
]

/** The ATS a hostname belongs to, or null when it is generic. Lower-cased, a
 *  leading `www.` dropped, and matched on a domain boundary, so
 *  `notgreenhouse.io` is never `greenhouse.io`. */
export function findAts(hostname: string): Ats | null {
  const host = hostname.trim().toLowerCase().replace(/^www\./, '')
  if (host === '') return null
  return ATS_LIST.find((ats) => ats.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null
}

/** Path segments that sit where a board's slug would and are never the Company. */
const BOARD_WORDS = new Set(['embed', 'jobs', 'boards', 'job-boards', 'api'])

/** The Company as `ats` writes it in a page title, or null. */
export function companyFromTitle(ats: Ats, title: string): string | null {
  const pattern = ats.company?.titlePattern
  if (pattern === undefined) return null
  const name = pattern.exec(title.replace(/\s+/g, ' ').trim())?.[1]?.trim()
  return name ? name : null
}

/** The Company's slug as `ats` writes it in an address, or null. */
export function companySlugFrom(ats: Ats, address: string): string | null {
  const pattern = ats.company?.slugPattern
  if (pattern === undefined) return null
  const slug = pattern.exec(address)?.[1]
  return slug && !BOARD_WORDS.has(slug.toLowerCase()) ? slug : null
}
