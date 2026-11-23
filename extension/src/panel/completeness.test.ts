import { describe, expect, it } from 'vitest'
import { missingFacts, profileCompleteness, REQUIRED_FACTS } from './completeness'

const FULL = { email: 'k@x.dev', phone: '+15550100', fullName: 'Ada Lovelace', country: 'United Kingdom' }

describe('profileCompleteness (O1)', () => {
  it('incomplete: a resume, a name, email and phone but no country', () => {
    const { country: _country, ...noCountry } = FULL
    expect(profileCompleteness(noCountry, true, true)).toBe('incomplete')
    expect(profileCompleteness({ ...noCountry, location: 'London, UK' }, true, true)).toBe('incomplete')
    expect(profileCompleteness({ ...noCountry, country: 'United Kingdom' }, true, true)).toBe('complete')
  })

  it('complete: resume + email + phone + fullName + country', () => {
    expect(profileCompleteness(FULL, true, true)).toBe('complete')
  })

  it('complete: firstName+lastName satisfies the name group', () => {
    expect(profileCompleteness(
      { email: 'k@x.dev', phone: '+15550100', firstName: 'Ada', lastName: 'Lovelace', country: 'United Kingdom' }, true, true,
    )).toBe('complete')
  })

  it('incomplete: firstName WITHOUT lastName does not satisfy the name group', () => {
    expect(profileCompleteness(
      { email: 'k@x.dev', phone: '+15550100', firstName: 'Ada', country: 'United Kingdom' }, true, true,
    )).toBe('incomplete')
  })

  it('incomplete: missing resume, even with every fact present', () => {
    expect(profileCompleteness(FULL, false, true)).toBe('incomplete')
  })

  it.each(['email', 'phone', 'country'] as const)('incomplete: missing %s', (k) => {
    expect(profileCompleteness({ ...FULL, [k]: '' }, true, true)).toBe('incomplete')
  })

  it('counts a phone only in international form: a Profile whose phone is old text is incomplete', () => {
    expect(profileCompleteness({ ...FULL, phone: '(555) 010-0100' }, true, true)).toBe('incomplete')
    expect(profileCompleteness({ ...FULL, phone: '+1 555 0100' }, true, true)).toBe('incomplete')
    expect(profileCompleteness({ ...FULL, phone: '+15550100' }, true, true)).toBe('complete')
  })

  it('names what is missing, the phone among it when it is old text', () => {
    expect(missingFacts(FULL, true)).toEqual([])
    expect(missingFacts({ ...FULL, phone: '(555) 010-0100' }, true)).toEqual(['phone'])
    expect(missingFacts({}, false)).toEqual(['resume', 'email', 'phone', 'name', 'country'])
  })

  it('whitespace-only values do not count', () => {
    expect(profileCompleteness({ ...FULL, email: '   ' }, true, true)).toBe('incomplete')
  })

  it('unknown: an unsettled load can NEVER prove incompleteness', () => {
    expect(profileCompleteness({}, false, false)).toBe('unknown')
  })

  it('unknown outranks a fully-present facts record too (settled is the gate)', () => {
    expect(profileCompleteness(FULL, true, false)).toBe('unknown')
  })

  /**
   * T1: this replaces `expect(REQUIRED_FACTS.length).toBe(3)`, which proved
   * nothing about the const beyond its current size — it failed for any edit,
   * correct or not. What is worth pinning is the NESTING CONTRACT the comment
   * on REQUIRED_FACTS promises, so the assertion is derived FROM the const:
   * adding "salary is required too" keeps this test meaningful rather than
   * merely making it red.
   */
  it('every group is required, and any ONE of its alternatives satisfies it', () => {
    REQUIRED_FACTS.forEach((group, i) => {
      for (const alt of group) {
        // Every other group satisfied by its first alternative; this one by `alt`.
        const facts: Record<string, string> = {}
        REQUIRED_FACTS.forEach((g, j) => { for (const k of (j === i ? alt : g[0]!)) facts[k] = k === 'phone' ? '+15550100' : 'x' })
        expect(profileCompleteness(facts, true, true)).toBe('complete')
        // …and this group alone is enough to fail the whole record (outer AND).
        for (const k of alt) delete facts[k]
        expect(profileCompleteness(facts, true, true)).toBe('incomplete')
      }
    })
  })
})

describe('About me and Onboarding (spec #98)', () => {
  it('Onboarding is complete with an empty About me: no required group asks for it', () => {
    expect(REQUIRED_FACTS.flat(2).some((k) => /about/i.test(k))).toBe(false)
    expect(profileCompleteness(FULL, true, true)).toBe('complete')
    expect(missingFacts(FULL, true)).toEqual([])
  })
})
