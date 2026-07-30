import { describe, expect, it } from 'vitest'
import { profileCompleteness, REQUIRED_FACTS } from './completeness'

const FULL = { email: 'k@x.dev', phone: '+55 11 90000-0000', fullName: 'Kevin B' }

describe('profileCompleteness (O1)', () => {
  it('complete: resume + email + phone + fullName', () => {
    expect(profileCompleteness(FULL, true, true)).toBe('complete')
  })

  it('complete: firstName+lastName satisfies the name group', () => {
    expect(profileCompleteness(
      { email: 'k@x.dev', phone: '1', firstName: 'Kevin', lastName: 'B' }, true, true,
    )).toBe('complete')
  })

  it('incomplete: firstName WITHOUT lastName does not satisfy the name group', () => {
    expect(profileCompleteness(
      { email: 'k@x.dev', phone: '1', firstName: 'Kevin' }, true, true,
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

  it('the required list is the one extensible const', () => {
    expect(REQUIRED_FACTS.length).toBe(3)
  })
})
