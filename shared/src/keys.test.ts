import { describe, it, expect } from 'vitest'
import { PROFILE_KEYS, ANSWER_BANK_KEYS, FIELD_KEYS, isFieldKey } from './keys.js'

describe('field key sets', () => {
  it('FIELD_KEYS is the union of profile and answer-bank keys with no duplicates', () => {
    expect(FIELD_KEYS).toEqual([...PROFILE_KEYS, ...ANSWER_BANK_KEYS])
    expect(new Set(FIELD_KEYS).size).toBe(FIELD_KEYS.length)
  })

  it('contains the exact keys the spec names', () => {
    expect(PROFILE_KEYS).toEqual([
      'firstName', 'lastName', 'fullName', 'preferredName',
      'email', 'phone', 'location', 'linkedin', 'github', 'portfolio',
    ])
    expect(ANSWER_BANK_KEYS).toEqual([
      'workAuth', 'sponsorshipNeeded', 'relocate', 'salary',
      'notice', 'earliestStart', 'remotePreference', 'pronouns',
    ])
  })

  it('isFieldKey is a closed-set guard', () => {
    expect(isFieldKey('email')).toBe(true)
    expect(isFieldKey('workAuth')).toBe(true)
    expect(isFieldKey('whyInterested')).toBe(false)
    expect(isFieldKey('__proto__')).toBe(false)
    expect(isFieldKey('')).toBe(false)
  })
})
