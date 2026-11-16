import { describe, it, expect } from 'vitest'
import { ATS_LIST, atsIdOf, companyFromTitle, companySlugFrom, findAts, isAtsOrGeneric, type Ats } from './ats.js'
import { GENERIC_MODULE, atsModule } from './atsModule.js'

// Ticket #42: the one list of ATSes (spec #41). Finding an ATS from a hostname,
// as a table in the style of the rule table tests. The hostnames are the boards
// the real-page fixtures and the live-apply review came from; the companies in
// them are placeholders.

const idOf = (hostname: string): string | null => findAts(hostname)?.id ?? null

describe('the list of ATSes: finding an ATS from a hostname', () => {
  it.each([
    ['jobs.lever.co', 'lever'],
    ['www.jobs.lever.co', 'lever'],
    ['JOBS.LEVER.CO', 'lever'],
    ['boards.greenhouse.io', 'greenhouse'],
    ['job-boards.greenhouse.io', 'greenhouse'],
    ['jobs.ashbyhq.com', 'ashby'],
    ['acme.wd5.myworkdayjobs.com', 'workday'],
    ['jobs.smartrecruiters.com', 'smartrecruiters'],
    ['apply.workable.com', 'workable'],
    ['acme.gupy.io', 'gupy'],
    ['acme.recruitee.com', 'recruitee'],
    ['acme.bamboohr.com', 'bamboohr'],
    ['careers-acme.icims.com', 'icims'],
  ])('finds %s as %s', (hostname, id) => {
    expect(idOf(hostname)).toBe(id)
  })

  it('matches an ATS apex host itself, not only its subdomains', () => {
    expect(idOf('greenhouse.io')).toBe('greenhouse')
    expect(idOf('www.lever.co')).toBe('lever')
  })

  it.each([
    'notlever.co',
    'lever.co.example.com',
    'notgreenhouse.io',
    'evil-greenhouse.io.attacker.com',
    'jobs.acme.com',
    'localhost',
    '127.0.0.1',
    '',
  ])('finds no ATS on %s: it is generic', (hostname) => {
    expect(findAts(hostname)).toBeNull()
  })
})

const entry = (hostname: string): Ats => {
  const ats = findAts(hostname)
  if (ats === null) throw new Error(`no ATS for ${hostname}`)
  return ats
}

describe('the list of ATSes: the id a Scan carries', () => {
  it('is the entry\'s id, or generic for a hostname on no entry', () => {
    expect(atsIdOf('jobs.lever.co')).toBe('lever')
    expect(atsIdOf('careers.example.com')).toBe('generic')
    expect(atsIdOf('')).toBe('generic')
  })

  it('reads a stored value as an id only when the list or generic names it', () => {
    expect(isAtsOrGeneric('ashby')).toBe(true)
    expect(isAtsOrGeneric('generic')).toBe(true)
    expect(isAtsOrGeneric('teamtailor')).toBe(false)
    expect(isAtsOrGeneric(undefined)).toBe(false)
  })
})

describe('the list of ATSes: how an ATS writes the Company', () => {
  it.each([
    ['boards.greenhouse.io', 'Job Application for Staff Engineer at Initech', 'Initech'],
    ['jobs.ashbyhq.com', 'Product Engineer @ Initech', 'Initech'],
    ['jobs.lever.co', 'Initech - Staff Engineer', 'Initech'],
  ])('reads the Company from a %s page title', (hostname, title, company) => {
    expect(companyFromTitle(entry(hostname), title)).toBe(company)
  })

  it.each([
    ['boards.greenhouse.io', 'https://job-boards.greenhouse.io/initech/jobs/4012345', 'initech'],
    ['boards.greenhouse.io', 'https://boards.greenhouse.io/embed/job_app?for=initech&token=1', 'initech'],
    ['jobs.ashbyhq.com', 'https://jobs.ashbyhq.com/initech/6edf242b/application', 'initech'],
    ['jobs.lever.co', 'https://jobs.lever.co/initech/0c1d2e3f/apply', 'initech'],
  ])('reads the Company slug from a %s address', (hostname, address, slug) => {
    expect(companySlugFrom(entry(hostname), address)).toBe(slug)
  })

  it('reads nothing from a title or address the ATS does not write that way', () => {
    expect(companyFromTitle(entry('jobs.lever.co'), 'Apply')).toBeNull()
    expect(companySlugFrom(entry('boards.greenhouse.io'), 'https://boards.greenhouse.io/embed/job_app')).toBeNull()
    expect(companySlugFrom(entry('jobs.lever.co'), 'https://jobs.acme.com/initech/1')).toBeNull()
  })

  it('knows the Company writing of Greenhouse, Ashby and Lever only', () => {
    expect(ATS_LIST.filter((a) => a.company !== undefined).map((a) => a.id).sort()).toEqual(['ashby', 'greenhouse', 'lever'])
    expect(companyFromTitle(entry('apply.workable.com'), 'Initech - Staff Engineer')).toBeNull()
  })
})

describe('the list of ATSes: tracking parameters for the Canonical URL', () => {
  it('strips them on Greenhouse and Ashby and nowhere else (ADR 0003)', () => {
    expect(ATS_LIST.filter((a) => a.stripsTrackingParams).map((a) => a.id).sort()).toEqual(['ashby', 'greenhouse'])
  })
})

describe('ATS modules', () => {
  it.each(['greenhouse', 'ashby', 'lever'] as const)('%s has a module with no label, Job posting text or junk rule', (id) => {
    const mod = atsModule(id)
    expect(mod).not.toBe(GENERIC_MODULE)
    expect(mod.id).toBe(id)
    expect(mod.labelRule).toBeUndefined()
    expect(mod.jobText).toBeUndefined()
    expect(mod.junkRule).toBeUndefined()
  })

  it('gives Ashby and Lever their empty-state hint, word for word, and Greenhouse none', () => {
    expect(atsModule('ashby').emptyStateHint).toBe('On Ashby the form is under the "Application" tab. Open it, then Scan again.')
    expect(atsModule('lever').emptyStateHint).toBe('On Lever the form opens from "Apply for this job". Open it, then Scan again.')
    expect(atsModule('greenhouse').emptyStateHint).toBeUndefined()
  })

  it('gives the generic module, with no layers, to an ATS with no module and to no ATS at all', () => {
    expect(atsModule('workable')).toBe(GENERIC_MODULE)
    expect(atsModule('recruitee')).toBe(GENERIC_MODULE)
    expect(atsModule(null)).toBe(GENERIC_MODULE)
    expect(atsModule(undefined)).toBe(GENERIC_MODULE)
    expect(atsModule('not-an-ats')).toBe(GENERIC_MODULE)
    expect(GENERIC_MODULE).toEqual({ id: 'generic' })
  })

  it('reaches a module from a hostname through the list', () => {
    expect(atsModule(findAts('jobs.lever.co')?.id).id).toBe('lever')
    expect(atsModule(findAts('jobs.acme.com')?.id)).toBe(GENERIC_MODULE)
  })
})
