import { describe, it, expect } from 'vitest'
import { guessCompany } from './company'

describe('guessCompany', () => {
  it('reads "at Company" from the tab title', () => {
    expect(guessCompany('Senior Engineer at Stripe', 'boards.greenhouse.io')).toBe('Stripe')
    expect(guessCompany('Job Application for SRE at Nubank', 'boards.greenhouse.io')).toBe('Nubank')
  })

  it('falls back to the second-level domain of a company-owned careers host', () => {
    expect(guessCompany('Careers', 'jobs.acme.com')).toBe('Acme')
  })

  it('returns null for ATS platform hosts, IPs and localhost', () => {
    expect(guessCompany('Job Application', 'boards.greenhouse.io')).toBeNull()
    expect(guessCompany('Apply', 'jobs.lever.co')).toBeNull()
    expect(guessCompany('Fixture', '127.0.0.1')).toBeNull()
    expect(guessCompany('Dev', 'localhost')).toBeNull()
  })
})

describe('guessCompany reads the shared list of ATSes (#42)', () => {
  // One hostname for each platform the guess's own list named before #42.
  it.each([
    ['greenhouse', 'job-boards.greenhouse.io'],
    ['lever', 'jobs.lever.co'],
    ['myworkdayjobs', 'acme.wd5.myworkdayjobs.com'],
    ['workday', 'www.workday.com'],
    ['ashbyhq', 'jobs.ashbyhq.com'],
    ['bamboohr', 'acme.bamboohr.com'],
    ['smartrecruiters', 'jobs.smartrecruiters.com'],
    ['icims', 'careers-acme.icims.com'],
    ['workable', 'apply.workable.com'],
    ['recruitee', 'acme.recruitee.com'],
    ['gupy', 'acme.gupy.io'],
  ])('refuses a %s hostname as the Company', (_platform, hostname) => {
    expect(guessCompany('Apply', hostname)).toBeNull()
    expect(guessCompany('Apply', hostname.toUpperCase())).toBeNull()
  })

  it("never returns an ATS's name, even from a title", () => {
    expect(guessCompany('Open roles at Lever', 'jobs.acme.com')).toBe('Acme')
    expect(guessCompany('Job Application for SRE at Greenhouse', 'boards.greenhouse.io')).toBeNull()
    expect(guessCompany('Jobs at SmartRecruiters', 'jobs.smartrecruiters.com')).toBeNull()
  })

  it('still reads a company-owned host that only looks like an ATS', () => {
    expect(guessCompany('Careers', 'jobs.notlever.co')).toBe('Notlever')
  })
})
