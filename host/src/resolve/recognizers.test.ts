import { describe, it, expect } from 'vitest'
import { recognize, BASELINE_RECOGNIZERS } from './recognizers.js'
import { openDb, saveLearnedMapping } from '../db/repos.js'
import { isFieldKey } from '@jff/shared'

describe('BASELINE_RECOGNIZERS', () => {
  it('only ever produces keys inside the closed set', () => {
    for (const r of BASELINE_RECOGNIZERS) expect(isFieldKey(r.key)).toBe(true)
  })
})

describe('recognize', () => {
  it.each([
    ['First Name *', 'firstName'],
    ['Last Name', 'lastName'],
    ['Full name', 'fullName'],
    ['Preferred First Name', 'preferredName'],
    ['E-mail', 'email'],
    ['Phone', 'phone'],
    ['LinkedIn Profile', 'linkedin'],
    ['GitHub URL', 'github'],
    ['Personal website', 'portfolio'],
    ['Will you now or in the future require sponsorship?', 'sponsorshipNeeded'],
    ['Are you legally authorized to work in Brazil?', 'workAuth'],
    ['Are you willing to relocate?', 'relocate'],
    ['Desired salary', 'salary'],
    ['Notice period', 'notice'],
    ['When can you start?', 'earliestStart'],
    ['Pronouns', 'pronouns'],
    ['Current location (city)', 'location'],
    ['Remote preference', 'remotePreference'],
  ])('maps %s to %s', (label, key) => {
    expect(recognize(label)).toBe(key)
  })

  it('does not match "Microphone" as phone (word-boundary guard)', () => {
    expect(recognize('Do you have a Microphone?')).toBeNull()
  })

  it('does not match a bare "name" substring like "Company name"', () => {
    expect(recognize('Company name')).toBeNull()
  })

  it('prefers the specific "Preferred First Name" over "First Name"', () => {
    expect(recognize('Preferred First Name')).toBe('preferredName')
  })

  it('returns null for a free-text question so it falls through to the LLM', () => {
    expect(recognize('Why do you want to join Figma?')).toBeNull()
    expect(recognize('Tell us about a hard technical decision you made.')).toBeNull()
  })

  it('lets a learned mapping win over the baseline', () => {
    const db = openDb(':memory:')
    saveLearnedMapping(db, 'onde voce mora', 'location')
    expect(recognize('Onde você mora?', db)).toBe('location')
  })
})
