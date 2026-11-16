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
    ['Are you legally authorized to work in Germany?', 'workAuth'],
    ['Are you willing to relocate?', 'relocate'],
    ['Desired salary', 'salary'],
    ['Notice period', 'notice'],
    ['When can you start?', 'earliestStart'],
    ['Pronouns', 'pronouns'],
    ['Current location (city)', 'city'],
    ['City', 'city'],
    ['Cidade', 'city'],
    ['Location', 'location'],
    ['Where are you based?', 'location'],
    ['Country', 'country'],
    ['Country of residence', 'country'],
    ['País', 'country'],
    ['State/Province', 'region'],
    ['State', 'region'],
    ['Region', 'region'],
    ['Estado', 'region'],
    ['Current company', 'currentCompany'],
    ['Current employer', 'currentCompany'],
    ['Empresa atual', 'currentCompany'],
    ['Current title', 'currentTitle'],
    ['Current job title', 'currentTitle'],
    ['Cargo atual', 'currentTitle'],
    ['Nome do cargo atual', 'currentTitle'],
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

  it('prefers the specific title over a name: "Nome do cargo atual" is a title', () => {
    expect(recognize('Nome do cargo atual')).toBe('currentTitle')
    expect(recognize('Nome da empresa atual')).toBe('currentCompany')
  })

  it('a phone country code and marital status are not places', () => {
    expect(recognize('Country code')).not.toBe('country')
    expect(recognize('Estado civil')).not.toBe('region')
  })

  it('prefers the specific "Preferred First Name" over "First Name"', () => {
    expect(recognize('Preferred First Name')).toBe('preferredName')
  })

  it('returns null for a free-text question so it falls through to the LLM', () => {
    expect(recognize('Why do you want to join Acme?')).toBeNull()
    expect(recognize('Tell us about a hard technical decision you made.')).toBeNull()
  })

  // Ticket #29: a residence question that names a place is a question about
  // the stored country, read BEFORE the location rule.
  it.each([
    ['Are you based in US or Canada?', 'country'],
    ['Do you live in the United States?', 'country'],
    ['Do you currently reside in Germany?', 'country'],
    ['Are you based in EMEA?', 'country'],
    ['Você mora em Portugal?', 'country'],
    ['Are you based in London?', 'location'],
    ['Where are you based?', 'location'],
  ])('reads the residence question %s as %s', (label, key) => {
    expect(recognize(label)).toBe(key)
  })

  it('an authorization question that mentions sponsorship as what it does without is still authorization', () => {
    expect(recognize('Are you legally authorized to work in the United States without sponsorship?')).toBe('workAuth')
    expect(recognize('Are you eligible to work in Germany without visa sponsorship?')).toBe('workAuth')
    expect(recognize('Você tem autorização para trabalhar no Canadá sem patrocínio?')).toBe('workAuth')
    expect(recognize('Will you now or in the future require sponsorship?')).toBe('sponsorshipNeeded')
    expect(recognize('Will you work in the US without sponsorship being needed?')).toBe('sponsorshipNeeded')
  })

  it('lets a learned mapping win over the baseline', () => {
    const db = openDb(':memory:')
    saveLearnedMapping(db, 'onde voce mora', 'location')
    expect(recognize('Onde você mora?', db)).toBe('location')
  })
})
