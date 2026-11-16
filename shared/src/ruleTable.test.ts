import { describe, it, expect } from 'vitest'
import { norm } from './norm.js'
import { FIELD_KEYS } from './keys.js'
import {
  RULE_LANGUAGES, RULE_TABLE, candidatesFor, candidatesForKey, countryCandidates, yesNoCandidates,
} from './ruleTable.js'

// Ticket #26: the rule table, tested directly (spec #6, testing decision 5).
// The Option wordings below are the ones the real-page fixtures under
// e2e/fixtures/real/ and the live-apply review offer: Lever's Portuguese
// "Sim"/"Não" selects, Ashby's "Yes"/"No" buttons, the intl-tel-input country
// list Greenhouse mounts on every page. Countries are not the maintainer's.

/** The one Option of `options` the Value picks by the table, as Fill compares. */
function pick(options: string[], words: string[]): string[] {
  const wanted = new Set(words.map(norm))
  return options.filter((o) => wanted.has(norm(o)))
}

const LEVER_PT_SELECT = ['Select...', 'Sim', 'Não']
const ASHBY_EN_BUTTONS = ['Yes', 'No']
const GREENHOUSE_COUNTRY_LIST = [
  'Germany', 'Ghana', 'Canada', 'Brazil', 'Portugal', 'United Kingdom', 'United States',
  'United States Minor Outlying Islands', 'U.S. Virgin Islands', 'United Arab Emirates', 'Mexico',
]
const PT_COUNTRY_SELECT = ['Selecione', 'Alemanha', 'Brasil', 'Canadá', 'Estados Unidos', 'México', 'Portugal']

describe('the rule table: yes and no', () => {
  it('gives "Yes" and "Sim" for a yes', () => {
    expect(yesNoCandidates('yes')).toEqual(['Yes', 'Sim'])
  })

  it('gives "No", "Não" and "Nao" for a no', () => {
    expect(yesNoCandidates('no')).toEqual(['No', 'Não', 'Nao'])
  })

  it('reads a yes or a no written in either language, in any case', () => {
    expect(yesNoCandidates('Sim')).toEqual(['Yes', 'Sim'])
    expect(yesNoCandidates('NÃO')).toEqual(['No', 'Não', 'Nao'])
    expect(yesNoCandidates('nao')).toEqual(['No', 'Não', 'Nao'])
  })

  it('never gives a word of the other answer: "Yes" is not a candidate for a no', () => {
    expect(yesNoCandidates('no')).not.toContain('Yes')
    expect(yesNoCandidates('no')).not.toContain('Sim')
    expect(yesNoCandidates('yes')).not.toContain('No')
    expect(yesNoCandidates('yes')).not.toContain('Não')
  })

  it('gives nothing for a Value that is neither yes nor no', () => {
    expect(yesNoCandidates('true')).toEqual([])
    expect(yesNoCandidates('Yes, I am authorized')).toEqual([])
    expect(yesNoCandidates('')).toEqual([])
  })

  it('picks the page wording from real Option lists in both languages', () => {
    expect(pick(LEVER_PT_SELECT, yesNoCandidates('yes'))).toEqual(['Sim'])
    expect(pick(LEVER_PT_SELECT, yesNoCandidates('no'))).toEqual(['Não'])
    expect(pick(ASHBY_EN_BUTTONS, yesNoCandidates('yes'))).toEqual(['Yes'])
    expect(pick(ASHBY_EN_BUTTONS, yesNoCandidates('no'))).toEqual(['No'])
  })
})

describe('the rule table: countries', () => {
  it("gives a country's English name, Portuguese name and short forms", () => {
    expect(countryCandidates('Germany')).toEqual(expect.arrayContaining(['Germany', 'Alemanha']))
    expect(countryCandidates('United States')).toEqual(
      expect.arrayContaining(['United States', 'Estados Unidos', 'US', 'USA', 'EUA']),
    )
  })

  it('finds the country from any of its names, in either language and any case', () => {
    expect(countryCandidates('alemanha')).toEqual(countryCandidates('Germany'))
    expect(countryCandidates('USA')).toEqual(countryCandidates('United States'))
    expect(countryCandidates('  estados   unidos ')).toEqual(countryCandidates('United States'))
  })

  it("never gives another country's words", () => {
    expect(countryCandidates('Germany')).not.toContain('Brazil')
    expect(countryCandidates('United States')).not.toContain('United Kingdom')
    expect(countryCandidates('United States')).not.toContain('United States Minor Outlying Islands')
  })

  it('gives nothing for a place outside the closed list', () => {
    expect(countryCandidates('London')).toEqual([])
    expect(countryCandidates('Atlantis')).toEqual([])
  })

  it('picks the page wording from real Option lists in both languages', () => {
    expect(pick(GREENHOUSE_COUNTRY_LIST, countryCandidates('Alemanha'))).toEqual(['Germany'])
    expect(pick(GREENHOUSE_COUNTRY_LIST, countryCandidates('Estados Unidos'))).toEqual(['United States'])
    expect(pick(GREENHOUSE_COUNTRY_LIST, countryCandidates('México'))).toEqual(['Mexico'])
    expect(pick(PT_COUNTRY_SELECT, countryCandidates('Germany'))).toEqual(['Alemanha'])
    expect(pick(PT_COUNTRY_SELECT, countryCandidates('USA'))).toEqual(['Estados Unidos'])
    expect(pick(PT_COUNTRY_SELECT, countryCandidates('Canada'))).toEqual(['Canadá'])
  })
})

describe('the rule table: its shape', () => {
  it('holds English and Portuguese', () => {
    expect(RULE_LANGUAGES).toEqual(['en', 'pt'])
  })

  it('gives every accented word without its accent too, since Fill does not fold accents', () => {
    const strip = (w: string): string => w.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    for (const lang of RULE_LANGUAGES) {
      const rows: (readonly string[])[] = [
        RULE_TABLE[lang].yes, RULE_TABLE[lang].no, ...Object.values(RULE_TABLE[lang].countries),
      ]
      for (const row of rows) {
        for (const word of row) {
          if (strip(word) !== word) expect(row, `${lang}: ${word}`).toContain(strip(word))
        }
      }
    }
  })

  it('lists the same closed set of countries in both languages', () => {
    expect(Object.keys(RULE_TABLE.pt.countries).sort()).toEqual(Object.keys(RULE_TABLE.en.countries).sort())
  })

  it('gives each word to one country only', () => {
    const owner = new Map<string, string>()
    for (const lang of RULE_LANGUAGES) {
      for (const [code, words] of Object.entries(RULE_TABLE[lang].countries)) {
        for (const w of words) {
          const prev = owner.get(norm(w))
          expect(prev === undefined || prev === code, `${w} is both ${prev} and ${code}`).toBe(true)
          owner.set(norm(w), code)
        }
      }
    }
  })
})

describe('candidates by Value type and by Known key', () => {
  it('renders a yes/no Value and a place Value by their type', () => {
    expect(candidatesFor('yes_no', 'yes')).toEqual(yesNoCandidates('yes'))
    expect(candidatesFor('place', 'Germany')).toEqual(countryCandidates('Germany'))
    expect(candidatesFor('text', 'Germany')).toEqual([])
  })

  it('attaches candidates to `country` alone', () => {
    expect(candidatesForKey('country', 'Germany')).toEqual(countryCandidates('Germany'))
    for (const key of FIELD_KEYS.filter((k) => k !== 'country')) {
      expect(candidatesForKey(key, 'Germany'), key).toEqual([])
      expect(candidatesForKey(key, 'yes'), key).toEqual([])
    }
  })

  it('gives the old free text of relocate, work authorization and sponsorship nothing', () => {
    expect(candidatesForKey('relocate', 'true')).toEqual([])
    expect(candidatesForKey('workAuth', 'true')).toEqual([])
    expect(candidatesForKey('sponsorshipNeeded', 'no')).toEqual([])
  })
})
