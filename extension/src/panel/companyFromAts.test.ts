import { describe, it, expect } from 'vitest'
import { atsIdOf, type AtsOrGeneric } from '@jff/shared'
import { guessCompany, guessScanCompany } from './company'

/**
 * The Company of a Scan (spec #41): the ATS's title pattern, then the ATS's
 * address slug, then the generic guess from the title and the hostname. The
 * title is the tab's; the address is the elected frame's when that frame is on
 * the ATS, and the tab's otherwise.
 */

interface Page { title: string; url: string; frameUrl?: string | null; ats?: AtsOrGeneric }

const hostOf = (url: string): string => new URL(url).hostname

/** The Scan's ATS the way the Scan finds it: the elected frame's, else the tab's. */
function guess({ title, url, frameUrl = null, ats }: Page): string | null {
  const scanAts = ats ?? atsIdOf(frameUrl !== null ? hostOf(frameUrl) : hostOf(url))
  return guessScanCompany({ ats: scanAts, title, hostname: hostOf(url), url, frameUrl })
}

describe('the Company on Lever', () => {
  it('comes from a title that follows Lever\'s pattern', () => {
    expect(guess({ title: 'Acme Rockets - Senior Engineer', url: 'https://jobs.lever.co/acme-rockets/123/apply' })).toBe('Acme Rockets')
    expect(guess({ title: 'Acme Rockets – Senior Engineer', url: 'https://jobs.lever.co/acme-rockets/123/apply' })).toBe('Acme Rockets')
  })

  it('comes from the address\'s first segment, written as words, when the title gives nothing', () => {
    expect(guess({ title: 'Apply', url: 'https://jobs.lever.co/acme-rockets/123/apply' })).toBe('Acme Rockets')
    expect(guess({ title: '', url: 'https://jobs.lever.co/acme_rockets/123' })).toBe('Acme Rockets')
  })
})

describe('the Company on Ashby', () => {
  it('comes from a title that follows Ashby\'s pattern', () => {
    expect(guess({ title: 'Senior Engineer @ Acme Rockets', url: 'https://jobs.ashbyhq.com/acme-rockets/123/application' })).toBe('Acme Rockets')
  })

  it('comes from the address\'s first segment, written as words, when the title gives nothing', () => {
    expect(guess({ title: 'Jobs', url: 'https://jobs.ashbyhq.com/acme-rockets/123/application' })).toBe('Acme Rockets')
    expect(guess({ title: 'Jobs', url: 'https://jobs.ashbyhq.com/acme.rockets/123' })).toBe('Acme Rockets')
  })

  it('reads the elected Ashby frame\'s address on a company\'s page', () => {
    expect(guess({
      title: 'Careers', url: 'https://careers.example.com/jobs/1', frameUrl: 'https://jobs.ashbyhq.com/acme-rockets/123/application',
    })).toBe('Acme Rockets')
  })
})

describe('the Company on Greenhouse', () => {
  it('a Greenhouse form inside an iframe on a company\'s page takes the frame\'s address when the title gives nothing', () => {
    expect(guess({
      title: 'Careers', url: 'https://www.acme.com/careers/job/1',
      frameUrl: 'https://boards.greenhouse.io/embed/job_app?for=acmerockets&token=123',
    })).toBe('Acmerockets')
    expect(guess({
      title: 'Careers', url: 'https://www.acme.com/careers/job/1',
      frameUrl: 'https://job-boards.greenhouse.io/embed/job_app?for=acme-rockets&token=123',
    })).toBe('Acme Rockets')
  })

  it('a Greenhouse page that gave a Company before still gives the same one', () => {
    for (const [title, url] of [
      ['Job Application for SRE at Nubank', 'https://boards.greenhouse.io/nubank/jobs/1'],
      ['Job Application for Senior Engineer at Acme Inc.', 'https://job-boards.greenhouse.io/acme/jobs/2'],
      ['Senior Engineer at Stripe', 'https://boards.greenhouse.io/stripe/jobs/3'],
    ] as const) {
      const before = guessCompany(title, hostOf(url))
      expect(before).not.toBeNull()
      expect(guess({ title, url })).toBe(before)
    }
  })

  it('takes the slug of a Greenhouse board when the title gives nothing', () => {
    expect(guess({ title: 'Job Application', url: 'https://job-boards.greenhouse.io/acme-rockets/jobs/2' })).toBe('Acme Rockets')
  })
})

describe('an ATS is never the Company', () => {
  it('no page on a known ATS hostname gets the ATS\'s name', () => {
    expect(guess({ title: 'Lever - Senior Engineer', url: 'https://jobs.lever.co/lever/123' })).toBeNull()
    expect(guess({ title: 'Engineer @ Ashby', url: 'https://jobs.ashbyhq.com/ashby/123' })).toBeNull()
    expect(guess({ title: 'Job Application for SRE at Greenhouse', url: 'https://boards.greenhouse.io/greenhouse/jobs/1' })).toBeNull()
    expect(guess({ title: 'Apply', url: 'https://jobs.ashbyhq.com/ashbyhq/123' })).toBeNull()
  })

  it('a board word in the slug\'s place is never the Company', () => {
    expect(guess({ title: 'Apply', url: 'https://boards.greenhouse.io/embed/job_app?token=123' })).toBeNull()
  })

  it('a list ATS with no Company writing gives nothing from its hostname', () => {
    expect(guess({ title: 'Apply', url: 'https://apply.workable.com/acme/j/123' })).toBeNull()
  })
})

describe('a page on an unknown site', () => {
  it('gets the same guess as before', () => {
    for (const [title, url] of [
      ['Careers', 'https://jobs.acme.com/apply'],
      ['Senior Engineer at Initech', 'https://careers.example.com/jobs/1'],
      ['Open roles at Lever', 'https://jobs.acme.com/apply'],
      ['Fixture', 'http://127.0.0.1:5173/form'],
      ['Dev', 'http://localhost:3000/'],
      ['Acme Rockets - Senior Engineer', 'https://jobs.example.com/apply'],
    ] as const) {
      expect(guess({ title, url })).toBe(guessCompany(title, hostOf(url)))
    }
  })

  it('an elected frame on an unknown site is read the generic way, from the tab', () => {
    expect(guess({ title: 'Careers', url: 'https://jobs.acme.com/apply', frameUrl: 'https://forms.example.org/f/1' }))
      .toBe('Acme')
  })
})
