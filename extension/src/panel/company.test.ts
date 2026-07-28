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
