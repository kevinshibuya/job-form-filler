import type Database from 'better-sqlite3'
import { countryCode, isOldText, readPlaces, workAuthCountries, type FieldKey } from '@jff/shared'
import { getStoredValue } from '../db/repos.js'
import { RESIDENCE_QUESTION } from './recognizers.js'

/**
 * Questions answered for the country they name (spec #6, ticket #29). Each
 * answer is a yes or a no worked out from `workAuth`, the list of countries
 * where the user may work, or from the user's own `country`:
 *
 * - Work authorization: yes when every country the label names is in the list.
 * - Sponsorship, the mirror: needed when a country the label names is not.
 *   Nothing is stored for it, so the two can never contradict each other.
 * - Residence ("are you based in", "do you live in"): yes when the user's own
 *   country is among the ones the label names.
 *
 * A label that names no country answers authorization and sponsorship for the
 * user's own country, and only as a proposal. A label that names a region (the
 * EU, EMEA) is not answered: which countries a company means by it is a guess.
 */

export type CountryQuestion = 'workAuth' | 'sponsorshipNeeded' | 'residence'

/** The Known key a Resolution of each question carries. */
export const KEY_OF: Readonly<Record<CountryQuestion, FieldKey>> = {
  workAuth: 'workAuth', sponsorshipNeeded: 'sponsorshipNeeded', residence: 'country',
}

/** The reasons a person reads on the row. */
export const NAMES_REGION = 'names-region'
export const NO_COUNTRY_NAMED = 'no-country-named'

/** A residence question that names at least one place, country or region. */
export function isResidenceQuestion(label: string): boolean {
  if (!RESIDENCE_QUESTION.test(label)) return false
  const { countries, regions } = readPlaces(label)
  return countries.length > 0 || regions.length > 0
}

/** Which country question a Field recognised for `key` asks, if any. */
export function countryQuestionOf(key: FieldKey | null, label: string): CountryQuestion | null {
  if (key === 'workAuth' || key === 'sponsorshipNeeded') return key
  if (key === 'country' && isResidenceQuestion(label)) return 'residence'
  return null
}

export type CountryOutcome =
  | { tier: 'auto' | 'proposed'; answer: 'yes' | 'no'; reason: string }
  | { tier: 'needs_input'; reason: string }

/** Why a stored Value is missing: nothing stored, or only old text. */
function missing(db: Database.Database, key: FieldKey): 'no-value' | 'no-stored-value' {
  return isOldText(key, getStoredValue(db, key)) ? 'no-value' : 'no-stored-value'
}

const yesNo = (b: boolean): 'yes' | 'no' => (b ? 'yes' : 'no')

/**
 * The answer to one country question. `prefix` names the layer that found
 * the key (`recognizer`, `llm-key`), as every other reason does.
 */
export function countryAnswer(db: Database.Database, question: CountryQuestion, label: string, prefix: string): CountryOutcome {
  const { countries, regions } = readPlaces(label)
  if (regions.length > 0) return { tier: 'needs_input', reason: NAMES_REGION }

  const storedCountry = getStoredValue(db, 'country')
  const own = storedCountry === null ? null : countryCode(storedCountry.trim())

  if (question === 'residence') {
    if (own === null) return { tier: 'needs_input', reason: `${prefix}:country:no-stored-value` }
    return { tier: 'auto', answer: yesNo(countries.includes(own)), reason: `${prefix}:residence` }
  }

  const list = workAuthCountries(getStoredValue(db, 'workAuth'))
  if (list === null) return { tier: 'needs_input', reason: `${prefix}:${question}:${missing(db, 'workAuth')}` }

  // No country named: the answer that holds for the user's own country, proposed.
  const named = countries.length > 0 ? countries : own === null ? null : [own]
  if (named === null) return { tier: 'needs_input', reason: `${prefix}:country:no-stored-value` }
  const authorized = named.every((c) => list.includes(c))
  const answer = yesNo(question === 'workAuth' ? authorized : !authorized)
  return countries.length > 0
    ? { tier: 'auto', answer, reason: `${prefix}:${question}` }
    : { tier: 'proposed', answer, reason: NO_COUNTRY_NAMED }
}
