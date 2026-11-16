import { describe, it, expect } from 'vitest'
import { CALLING_CODES, RULE_TABLE, countryCode } from './ruleTable.js'
import {
  displayValue, isOldText, languageValues, phoneProposal, salaryOf, storedValue, toStoredText, workAuthCountries, workAuthValue,
} from './typedValues.js'

// Ticket #27: each typed Value has one canonical text form, with its parse and
// its format. A stored text is a Value only when it already is that form.

describe('the canonical text of a typed Value', () => {
  it('relocate: exactly yes or no is a Value; any other text is old text', () => {
    expect(storedValue('relocate', 'yes')).toBe('yes')
    expect(storedValue('relocate', 'no')).toBe('no')
    for (const old of ['Yes', 'true', 'Yes, anywhere in Europe', ' yes']) {
      expect(storedValue('relocate', old), old).toBeNull()
      expect(isOldText('relocate', old), old).toBe(true)
    }
  })

  it('phone: a plus sign and digits only is a Value; anything else is old text', () => {
    expect(storedValue('phone', '+15550100')).toBe('+15550100')
    for (const old of ['+1 555 0100', '(555) 010-0100', '5550100', '+', '+0123']) {
      expect(storedValue('phone', old), old).toBeNull()
      expect(isOldText('phone', old), old).toBe(true)
    }
  })

  it('an empty text is neither a Value nor old text', () => {
    expect(storedValue('phone', '')).toBeNull()
    expect(isOldText('phone', '')).toBe(false)
    expect(isOldText('relocate', '')).toBe(false)
  })

  it('a key without a typed form stores any text as its Value', () => {
    for (const key of ['pronouns', 'location', 'email'] as const) {
      expect(storedValue(key, 'anything at all'), key).toBe('anything at all')
      expect(isOldText(key, 'anything at all'), key).toBe(false)
    }
  })
})

describe('a Value formatted for a person or a model', () => {
  it('a yes or a no is written in the language asked for, English by default', () => {
    expect(displayValue('relocate', 'yes')).toBe('Yes')
    expect(displayValue('relocate', 'no')).toBe('No')
    expect(displayValue('relocate', 'yes', 'pt')).toBe('Sim')
    expect(displayValue('relocate', 'no', 'pt')).toBe('Não')
  })

  it('a phone is shown in international form', () => {
    expect(displayValue('phone', '+15550100')).toBe('+15550100')
  })

  it('old text formats to nothing', () => {
    expect(displayValue('relocate', 'Yes, anywhere in Europe')).toBeNull()
    expect(displayValue('phone', '+1 555 0100')).toBeNull()
  })
})

describe('a write', () => {
  it('a phone drops spaces and punctuation, then must be in international form', () => {
    expect(toStoredText('phone', '+1 555 0100')).toEqual({ ok: true, text: '+15550100' })
    expect(toStoredText('phone', '+1 (555) 010-0100')).toEqual({ ok: true, text: '+15550100100' })
    expect(toStoredText('phone', '(555) 010-0100')).toMatchObject({ ok: false })
    expect(toStoredText('phone', '+1 555 CALL ADA')).toMatchObject({ ok: false })
  })

  it('relocate takes any yes or no word of the rule table', () => {
    expect(toStoredText('relocate', 'yes')).toEqual({ ok: true, text: 'yes' })
    expect(toStoredText('relocate', 'Sim')).toEqual({ ok: true, text: 'yes' })
    expect(toStoredText('relocate', 'Não')).toEqual({ ok: true, text: 'no' })
    expect(toStoredText('relocate', 'Yes, anywhere in Europe')).toMatchObject({ ok: false })
  })

  it('an empty write passes, so it can still delete', () => {
    expect(toStoredText('phone', '')).toEqual({ ok: true, text: '' })
    expect(toStoredText('relocate', '')).toEqual({ ok: true, text: '' })
  })

  it('a key without a typed form writes its text unchanged', () => {
    expect(toStoredText('pronouns', 'she/her')).toEqual({ ok: true, text: 'she/her' })
  })
})

describe('the closed country list and calling codes', () => {
  it('every country in the list has a calling code', () => {
    for (const code of Object.keys(RULE_TABLE.en.countries)) {
      expect(CALLING_CODES[code], code).toMatch(/^[1-9]\d{0,2}$/)
    }
  })

  it('a country is found by any of its names, in either language', () => {
    expect(countryCode('United States')).toBe('us')
    expect(countryCode('EUA')).toBe('us')
    expect(countryCode('Alemanha')).toBe('de')
    expect(countryCode('Atlantis')).toBeNull()
  })
})

describe('the phone proposal', () => {
  it('an old number gets its digits, leading zeros dropped, behind the calling code of the country', () => {
    expect(phoneProposal('(555) 010-0100', 'United States')).toBe('+15550100100')
    expect(phoneProposal('030 1234567', 'Germany')).toBe('+49301234567')
  })

  it('an old number with a plus sign is proposed as it is, digits only, whatever the country', () => {
    expect(phoneProposal('+1 555 0100', 'United States')).toBe('+15550100')
    expect(phoneProposal('+1 555 0100', '')).toBe('+15550100')
  })

  it('no country, or one outside the list, and no plus sign: no proposal', () => {
    expect(phoneProposal('(555) 010-0100', '')).toBeNull()
    expect(phoneProposal('(555) 010-0100', 'Atlantis')).toBeNull()
  })

  it('a stored Value, an empty text or one with no digits gets no proposal', () => {
    expect(phoneProposal('+15550100', 'United States')).toBeNull()
    expect(phoneProposal('', 'United States')).toBeNull()
    expect(phoneProposal('call me', 'United States')).toBeNull()
  })
})

// Ticket #29: work authorization is the list of countries where the user may
// work, and sponsorship is derived from it, so nothing is stored for it.
describe('workAuth is a list of countries', () => {
  it('its canonical text is the sorted ISO codes of the closed list, as JSON', () => {
    expect(workAuthValue(['pt', 'de'])).toBe('["de","pt"]')
    expect(storedValue('workAuth', '["de","pt"]')).toBe('["de","pt"]')
    expect(workAuthCountries('["de","pt"]')).toEqual(['de', 'pt'])
  })

  it('a bare yes, a bare no and any free text stored before this ticket are old text', () => {
    for (const old of ['yes', 'no', 'true', 'Yes', 'Authorized to work in Germany', 'Germany', '["pt","de"]', '[]', '["xx"]']) {
      expect(storedValue('workAuth', old), old).toBeNull()
      expect(isOldText('workAuth', old), old).toBe(true)
      expect(workAuthCountries(old), old).toBeNull()
    }
  })

  it('is shown to a person or a model as the countries by name, in the language asked for', () => {
    expect(displayValue('workAuth', '["de","pt"]')).toBe('Germany, Portugal')
    expect(displayValue('workAuth', '["de","pt"]', 'pt')).toBe('Alemanha, Portugal')
    expect(displayValue('workAuth', 'yes')).toBeNull()
  })

  it('a write takes a list of codes or names and stores the canonical text; anything else is refused', () => {
    expect(toStoredText('workAuth', '["pt","Germany"]')).toEqual({ ok: true, text: '["de","pt"]' })
    expect(toStoredText('workAuth', '["de","de"]')).toEqual({ ok: true, text: '["de"]' })
    for (const bad of ['yes', 'Germany', '[]', '["Atlantis"]', '{"de":true}']) {
      const r = toStoredText('workAuth', bad)
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/workAuth is stored as a list of countries/)
    }
    expect(toStoredText('workAuth', '')).toEqual({ ok: true, text: '' })
  })
})

describe('sponsorshipNeeded stores nothing', () => {
  it('no stored text is ever its Value, and a write of anything but a delete is refused', () => {
    expect(storedValue('sponsorshipNeeded', 'no')).toBeNull()
    expect(displayValue('sponsorshipNeeded', 'yes')).toBeNull()
    const r = toStoredText('sponsorshipNeeded', 'no')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/workAuth/)
    expect(toStoredText('sponsorshipNeeded', '')).toEqual({ ok: true, text: '' })
  })
})

// Ticket #33: a salary is an amount with its currency and period, and the
// notice period, start date and remote preference hold one text per language.
describe('the salary and per-language forms', () => {
  const SALARY = '{"amount":90000,"currency":"EUR","period":"year"}'

  it('salary: only the canonical JSON is a Value; a figure typed as text is old text', () => {
    expect(salaryOf(SALARY)).toEqual({ amount: 90000, currency: 'EUR', period: 'year' })
    for (const old of ['100k', 'R$ 18.000/mo', '90000', '{"currency":"EUR","amount":90000,"period":"year"}', '{"amount":"90000","currency":"EUR","period":"year"}']) {
      expect(storedValue('salary', old), old).toBeNull()
      expect(isOldText('salary', old), old).toBe(true)
    }
  })

  it('salary: shown in words in each language', () => {
    expect(displayValue('salary', SALARY)).toBe('90000 EUR per year')
    expect(displayValue('salary', SALARY, 'pt')).toBe('90000 EUR por ano')
    expect(displayValue('salary', '{"amount":45.5,"currency":"GBP","period":"hour"}')).toBe('45.5 GBP per hour')
  })

  it('salary: a write needs all three parts, and is refused without any one of them', () => {
    expect(toStoredText('salary', '{"amount":"90000","currency":"eur","period":"year"}')).toEqual({ ok: true, text: SALARY })
    for (const bad of ['{"amount":"90000","currency":"EUR"}', '{"amount":"","currency":"EUR","period":"year"}', '{"amount":"9,000","currency":"EUR","period":"year"}', '{"amount":"0","currency":"EUR","period":"year"}']) {
      expect(toStoredText('salary', bad), bad).toMatchObject({ ok: false })
    }
  })

  it('per-language: the canonical JSON is a Value; plain text is old text in both languages', () => {
    expect(languageValues('{"en":"30 days","pt":"30 dias"}')).toEqual({ en: '30 days', pt: '30 dias' })
    expect(languageValues('{"pt":"Imediato"}')).toEqual({ pt: 'Imediato' })
    for (const old of ['30 dias', '{"pt":"30 dias","en":"30 days"}', '{"en":""}', '{}']) {
      expect(storedValue('notice', old), old).toBeNull()
    }
    expect(isOldText('notice', '30 dias')).toBe(true)
  })

  it('per-language: shown with each language named, never as JSON', () => {
    expect(displayValue('earliestStart', '{"en":"Immediately","pt":"Imediato"}')).toBe('Immediately (English); Imediato (Portuguese)')
    expect(displayValue('remotePreference', '{"en":"Remote"}')).toBe('Remote (English)')
  })

  it('per-language: a write keeps the languages given, one line each, and refuses any other language', () => {
    expect(toStoredText('notice', '{"pt":"30 dias","en":""}')).toEqual({ ok: true, text: '{"pt":"30 dias"}' })
    expect(toStoredText('notice', '{"fr":"30 jours"}')).toMatchObject({ ok: false })
    expect(toStoredText('notice', '30 days')).toMatchObject({ ok: false })
  })
})
