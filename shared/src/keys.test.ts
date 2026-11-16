import { describe, it, expect } from 'vitest'
import {
  PROFILE_KEYS, ANSWER_BANK_KEYS, FIELD_KEYS, VALUE_TYPES, VALUE_TYPE_OF, isFieldKey, isProfileKey, normalizeFactValue, FACT_MAX_CHARS,
} from './keys.js'

describe('field key sets', () => {
  it('FIELD_KEYS is the union of profile and answer-bank keys with no duplicates', () => {
    expect(FIELD_KEYS).toEqual([...PROFILE_KEYS, ...ANSWER_BANK_KEYS])
    expect(new Set(FIELD_KEYS).size).toBe(FIELD_KEYS.length)
  })

  it('contains the exact keys the spec names', () => {
    expect(PROFILE_KEYS).toEqual([
      'firstName', 'lastName', 'fullName', 'preferredName',
      'email', 'phone', 'location', 'city', 'region', 'country',
      'linkedin', 'github', 'portfolio', 'currentCompany', 'currentTitle',
    ])
    expect(ANSWER_BANK_KEYS).toEqual([
      'workAuth', 'sponsorshipNeeded', 'relocate', 'salary',
      'notice', 'earliestStart', 'remotePreference', 'pronouns',
    ])
  })

  it('holds twenty-three Known keys', () => {
    expect(FIELD_KEYS).toHaveLength(23)
  })

  it('isFieldKey is a closed-set guard', () => {
    expect(isFieldKey('email')).toBe(true)
    expect(isFieldKey('workAuth')).toBe(true)
    for (const k of ['city', 'region', 'country', 'currentCompany', 'currentTitle']) {
      expect(isFieldKey(k)).toBe(true)
      expect(isProfileKey(k)).toBe(true)
    }
    expect(isFieldKey('whyInterested')).toBe(false)
    expect(isFieldKey('__proto__')).toBe(false)
    expect(isFieldKey('')).toBe(false)
  })
})

describe('Value types', () => {
  it('gives every Known key exactly one Value type, and no type to anything else', () => {
    for (const key of FIELD_KEYS) {
      expect(VALUE_TYPES, `Known key ${key} has no Value type`).toContain(VALUE_TYPE_OF[key])
    }
    expect(Object.keys(VALUE_TYPE_OF).sort()).toEqual([...FIELD_KEYS].sort())
  })

  it('types each Known key as the spec\'s table does', () => {
    const byType = (type: string) => FIELD_KEYS.filter((k) => VALUE_TYPE_OF[k] === type).sort()
    expect(byType('link')).toEqual(['github', 'linkedin', 'portfolio'])
    expect(byType('phone')).toEqual(['phone'])
    expect(byType('yes_no')).toEqual(['relocate', 'sponsorshipNeeded'])
    expect(byType('place_list')).toEqual(['workAuth'])
    expect(byType('text')).toEqual([
      'currentCompany', 'currentTitle', 'email', 'firstName', 'fullName', 'lastName',
      'location', 'preferredName', 'pronouns',
    ])
    expect(byType('amount')).toEqual(['salary'])
    expect(byType('per_language')).toEqual(['earliestStart', 'notice', 'remotePreference'])
    expect(byType('place')).toEqual(['city', 'country', 'region'])
  })
})

describe('normalizeFactValue', () => {
  it('collapses every run of whitespace, newlines included, into one space and trims', () => {
    expect(normalizeFactValue('  Springfield,\n  RS,\tBrasil  ')).toBe('Springfield, RS, Brasil')
    expect(normalizeFactValue('a\r\n\r\nb')).toBe('a b')
  })

  it('leaves an already-clean value alone and keeps an empty value empty', () => {
    expect(normalizeFactValue('https://github.com/kevinshibuya')).toBe('https://github.com/kevinshibuya')
    expect(normalizeFactValue('   ')).toBe('')
    expect(FACT_MAX_CHARS).toBe(500)
  })
})
