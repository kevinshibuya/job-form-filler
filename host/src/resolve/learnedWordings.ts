import type Database from 'better-sqlite3'
import { VALUE_TYPE_OF, countryCode, norm, yesNoOf, type FieldKey, type LearnWordingParams } from '@jff/shared'
import { getLearnedWordings, saveLearnedWording } from '../db/repos.js'

/**
 * Learned wordings (ticket #35, GLOSSARY "Learned wording"): an Option the user
 * accepted for a Field answered from a Known key, stored with the key and the
 * Value it stood for. On later Resolutions of that key it joins the rule
 * table's candidate words while the key's Value is still the one it was
 * learned for. User data about the user's own answers, kept in the Native
 * host's database; not ATS knowledge (ADR 0007).
 */

/** Keys whose Resolution answers a yes or a no worked out per country, never the stored list itself. */
const DERIVED_YES_NO: ReadonlySet<FieldKey> = new Set(['workAuth', 'sponsorshipNeeded'])

/**
 * The form a Value is learned and looked up under, so the same Value in either
 * language meets the same wordings: a yes or a no as `yes` or `no`, a country
 * by its ISO 3166 code, anything else through `norm`. A derived answer is
 * learned only for its yes or no; any other Value of such a key gives null.
 */
export function learnedValueOf(key: FieldKey, value: string): string | null {
  const yesNo = yesNoOf(value)
  if (yesNo !== null) return yesNo
  if (DERIVED_YES_NO.has(key)) return null
  if (VALUE_TYPE_OF[key] === 'place') return countryCode(value) ?? norm(value)
  const n = norm(value)
  return n === '' ? null : n
}

/** Stores the wording the user accepted. False when the Value is not one a wording can be learned for. */
export function learnWording(db: Database.Database, p: LearnWordingParams): boolean {
  const value = learnedValueOf(p.key, p.value)
  if (value === null || p.wording.trim() === '') return false
  saveLearnedWording(db, p.key, value, p.wording)
  return true
}

/** The wordings learned for this key's Value, as the Resolution gives it. */
export function learnedWordingsFor(db: Database.Database, key: FieldKey, value: string): string[] {
  const canonical = learnedValueOf(key, value)
  return canonical === null ? [] : getLearnedWordings(db, key, canonical)
}

/**
 * The one Option equal to a wording learned for this key's Value, in the
 * page's wording; null when none is, or when several are: a choice is never
 * guessed between two.
 */
export function learnedOptionOf(db: Database.Database, key: FieldKey, value: string, options: readonly string[]): string | null {
  const wanted = new Set(learnedWordingsFor(db, key, value).map(norm))
  if (wanted.size === 0) return null
  const hits = options.filter((o) => wanted.has(norm(o)))
  return hits.length === 1 ? hits[0]! : null
}
