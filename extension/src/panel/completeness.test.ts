import { describe, expect, it } from 'vitest'
import { profileCompleteness, REQUIRED_FACTS } from './completeness'

const FULL = { email: 'k@x.dev', phone: '+1 555 0100', fullName: 'Ada Lovelace' }

describe('profileCompleteness (O1)', () => {
  it('complete: resume + email + phone + fullName', () => {
    expect(profileCompleteness(FULL, true, true)).toBe('complete')
  })

  it('complete: firstName+lastName satisfies the name group', () => {
    expect(profileCompleteness(
      { email: 'k@x.dev', phone: '1', firstName: 'Ada', lastName: 'Lovelace' }, true, true,
    )).toBe('complete')
  })

  it('incomplete: firstName WITHOUT lastName does not satisfy the name group', () => {
    expect(profileCompleteness(
      { email: 'k@x.dev', phone: '1', firstName: 'Ada' }, true, true,
    )).toBe('incomplete')
  })

  it('incomplete: missing resume, even with every fact present', () => {
    expect(profileCompleteness(FULL, false, true)).toBe('incomplete')
  })

  it.each(['email', 'phone'] as const)('incomplete: missing %s', (k) => {
    expect(profileCompleteness({ ...FULL, [k]: '' }, true, true)).toBe('incomplete')
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
        REQUIRED_FACTS.forEach((g, j) => { for (const k of (j === i ? alt : g[0]!)) facts[k] = 'x' })
        expect(profileCompleteness(facts, true, true)).toBe('complete')
        // …and this group alone is enough to fail the whole record (outer AND).
        for (const k of alt) delete facts[k]
        expect(profileCompleteness(facts, true, true)).toBe('incomplete')
      }
    })
  })
})
