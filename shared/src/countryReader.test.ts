import { describe, it, expect } from 'vitest'
import { readCountries, readPlaces } from './countryReader.js'

// Ticket #29: the country reader finds the countries a Field's label names,
// from the closed list, in English and Portuguese, with the common short
// forms. Tested directly, as the rule table is (spec #6, testing decision 5).
// The labels are the wordings real forms use.

describe('the country reader', () => {
  it.each([
    ['Are you authorized to work in Germany?', ['de']],
    ['Are you legally authorized to work in the United States?', ['us']],
    ['Are you authorized to work in the US or Canada?', ['us', 'ca']],
    ['Are you based in  US or Canada?', ['us', 'ca']],
    ['Will you require sponsorship to work in the U.S.?', ['us']],
    ['Are you eligible to work in the USA, the UK or Ireland?', ['us', 'gb', 'ie']],
    ['Do you have the right to work in the United Kingdom?', ['gb']],
    ['Are you authorized to work in the Netherlands, Spain and Portugal?', ['nl', 'es', 'pt']],
  ])('finds the countries in %j', (label, codes) => {
    expect(readCountries(label)).toEqual(codes)
  })

  it.each([
    ['Você tem autorização para trabalhar na Alemanha?', ['de']],
    ['Você tem autorização para trabalhar nos EUA?', ['us']],
    ['Você mora na Espanha ou em Portugal?', ['es', 'pt']],
    ['Você tem autorizacao para trabalhar no Canada?', ['ca']],
    ['Você tem autorização para trabalhar no Canadá ou nos Estados Unidos?', ['ca', 'us']],
  ])('finds the countries in the Portuguese %j', (label, codes) => {
    expect(readCountries(label)).toEqual(codes)
  })

  it.each([
    'What is your status?',
    'Are you legally authorized to work for us?',
    'Are you legally authorized to work in the country where this job is located?',
    'Tell us about yourself',
    'Are you based in London?',
  ])('finds no country in %j', (label) => {
    expect(readCountries(label)).toEqual([])
  })

  it('reads a short form only in capitals and as a whole word', () => {
    expect(readCountries('Would you work for us?')).toEqual([])
    expect(readCountries('Would you work for Us?')).toEqual([])
    expect(readCountries('Are you a USB expert?')).toEqual([])
    expect(readCountries('Do you live in the UK?')).toEqual(['gb'])
    expect(readCountries('Do you live in the uk?')).toEqual([])
  })

  it('reads a full name in any case, but only as a whole word', () => {
    expect(readCountries('ARE YOU AUTHORIZED TO WORK IN GERMANY?')).toEqual(['de'])
    expect(readCountries('Do you speak Germanyish?')).toEqual([])
    expect(readCountries('Have you worked in Indiana?')).toEqual([])
  })

  it('names each country once, in the order the label names them', () => {
    expect(readCountries('Are you authorized to work in the United States (USA) or Canada?')).toEqual(['us', 'ca'])
  })

  it('a longer name wins over the shorter one inside it', () => {
    expect(readPlaces('Do you live in South Africa?')).toEqual({ countries: ['za'], regions: [] })
    expect(readCountries('Do you live in Hong Kong SAR China?')).toEqual(['hk'])
  })
})

describe('regions', () => {
  it.each([
    ['Are you authorized to work in the EU?', ['EU']],
    ['Are you based in EMEA?', ['EMEA']],
    ['Are you located in LATAM?', ['LATAM']],
    ['Are you authorized to work in the European Union?', ['European Union']],
    ['Você mora na Europa?', ['Europa']],
  ])('finds the region %j names', (label, regions) => {
    expect(readPlaces(label)).toEqual({ countries: [], regions })
  })

  it('reads EU only in capitals: "eu" in Portuguese is "I"', () => {
    expect(readPlaces('Eu tenho autorização?').regions).toEqual([])
  })

  it('a label naming a country and a region names both', () => {
    expect(readPlaces('Are you authorized to work in the US or the EU?')).toEqual({ countries: ['us'], regions: ['EU'] })
  })
})
