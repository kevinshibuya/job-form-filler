import { normalizeFactValue, type FieldKey } from './keys.js'
import type { CityParts, PhoneParts } from './field.js'
import { CALLING_CODES, COUNTRY_CODES, RULE_TABLE, countryCode, countryName, countryNames, yesNoOf, type RuleLanguage } from './ruleTable.js'

/**
 * The rule for a Known key whose Value changed shape. Each typed Value has one
 * canonical text form, defined here once with its parse and its format, and
 * that text is what the Native host stores and what a profile write carries.
 *
 * - A stored text is a Value only when it already is exactly that form. Any
 *   other text is old text: shown as a hint wherever the facts are edited, and
 *   never parsed into the new shape. The key has no Value until the user
 *   enters one.
 * - A Value shown to a person or handed to a model is formatted from its typed
 *   form.
 *
 * `relocate` (a yes or a no), `phone` (international form) and `workAuth` (a
 * list of countries) have a typed form. `sponsorshipNeeded` has one that no
 * text fits: its answer is derived from `workAuth` and nothing is stored for
 * it. Every other key stores and answers its text as is.
 */

interface TypedForm {
  /** The stored text is a Value: exactly the canonical form. */
  readonly isValue: (text: string) => boolean
  /** The Value as a person or a model reads it, in a language when it has words. */
  readonly display: (text: string, lang: RuleLanguage) => string
  /** A write: the canonical text for what the user entered, or null when refused. */
  readonly fromInput: (text: string) => string | null
  /** Why a write is refused, said beside the key and by the Native host. */
  readonly refusal: string
}

/** A plus sign, the country calling code and the number, digits only. */
const PHONE_FORM = /^\+[1-9]\d{3,14}$/

const YES_NO: TypedForm = {
  isValue: (text) => text === 'yes' || text === 'no',
  display: (text, lang) => RULE_TABLE[lang][text as 'yes' | 'no'][0]!,
  fromInput: (text) => yesNoOf(text),
  refusal: 'is stored as a yes or a no',
}

const PHONE: TypedForm = {
  isValue: (text) => PHONE_FORM.test(text),
  display: (text) => text,
  // Spaces and punctuation go; a plus sign is not punctuation and stays.
  fromInput: (text) => {
    const cleaned = text.replace(/[\s\p{P}]/gu, '')
    return PHONE_FORM.test(cleaned) ? cleaned : null
  },
  refusal: 'is stored in international form: a plus sign, the country calling code and the number, as in +15550100',
}

const CODE_SET: ReadonlySet<string> = new Set(COUNTRY_CODES)

/** The canonical text of a list of countries: its ISO codes, each once, sorted, as JSON. */
export function workAuthValue(codes: readonly string[]): string {
  return JSON.stringify([...new Set(codes)].sort())
}

/** The JSON array a text holds, or null. */
function jsonArray(text: string): unknown[] | null {
  if (!text.startsWith('[')) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The countries of a stored `workAuth` Value, as ISO codes; null for old text.
 * Only the canonical text is a Value: a bare yes or no stored before the list
 * existed, or any other text, is not.
 */
export function workAuthCountries(text: string | null | undefined): string[] | null {
  if (text == null) return null
  const items = jsonArray(text)
  if (items === null || items.length === 0) return null
  if (!items.every((c): c is string => typeof c === 'string' && CODE_SET.has(c))) return null
  return workAuthValue(items) === text ? items : null
}

const PLACE_LIST: TypedForm = {
  isValue: (text) => workAuthCountries(text) !== null,
  display: (text, lang) => (workAuthCountries(text) ?? []).map((c) => countryName(c, lang) ?? c).join(', '),
  // A JSON list whose items are codes of the closed list or any of their names.
  fromInput: (text) => {
    const items = jsonArray(text)
    if (items === null || items.length === 0) return null
    const codes = items.map((i) => (typeof i !== 'string' ? null : CODE_SET.has(i) ? i : countryCode(i.trim())))
    return codes.every((c): c is string => c !== null) ? workAuthValue(codes) : null
  },
  refusal: 'is stored as a list of countries from the closed list',
}

/** No text is a Value: the answer is worked out from `workAuth` each time. */
const DERIVED: TypedForm = {
  isValue: () => false,
  display: (text) => text,
  fromInput: () => null,
  refusal: 'is not stored: its answer comes from workAuth, the countries where you may work',
}

const TYPED: Partial<Record<FieldKey, TypedForm>> = {
  relocate: YES_NO, phone: PHONE, workAuth: PLACE_LIST, sponsorshipNeeded: DERIVED,
}

/** Why a write of `key` would be refused, for a key with a typed form; null otherwise. */
export function refusalOf(key: FieldKey): string | null {
  return TYPED[key]?.refusal ?? null
}

/** True for a Known key whose Value has a canonical text form. */
export function hasTypedForm(key: FieldKey): boolean {
  return TYPED[key] !== undefined
}

/**
 * The stored text when it is a Value of its key, else null. A key without a
 * typed form takes any non-empty text.
 */
export function storedValue(key: FieldKey, text: string | null | undefined): string | null {
  if (text == null || text === '') return null
  const form = TYPED[key]
  return form === undefined || form.isValue(text) ? text : null
}

/** A stored text of a typed key that is not its canonical form. */
export function isOldText(key: FieldKey, text: string | null | undefined): boolean {
  return text != null && text.trim() !== '' && storedValue(key, text) === null
}

/**
 * A stored Value formatted for a person or a model: a yes or a no in the
 * language asked for, a phone in international form, any other key's text as
 * is. Old text and an empty text format to null.
 */
export function displayValue(key: FieldKey, text: string | null | undefined, lang: RuleLanguage = 'en'): string | null {
  const value = storedValue(key, text)
  if (value === null) return null
  return TYPED[key]?.display(value, lang) ?? value
}

export type StoredTextResult = { ok: true; text: string } | { ok: false; reason: string }

/**
 * What a write of `key` stores for the text the user entered. Empty passes, so
 * a write can still delete. A typed key stores its canonical form or is
 * refused; any other key stores the text unchanged.
 */
export function toStoredText(key: FieldKey, input: string): StoredTextResult {
  const form = TYPED[key]
  if (form === undefined || normalizeFactValue(input) === '') return { ok: true, text: input }
  const text = form.fromInput(normalizeFactValue(input))
  return text === null ? { ok: false, reason: `${key} ${form.refusal}` } : { ok: true, text }
}

/**
 * The one proposal the editor makes by itself: an old phone in international
 * form. An old number that starts with a plus sign is proposed as it is,
 * digits only. Any other is its digits, leading zeros dropped, behind the
 * calling code of `country`, which must be in the closed list. A stored Value,
 * or a number with no digits, gets none.
 */
export function phoneProposal(old: string, country: string | null | undefined): string | null {
  const text = old.trim()
  if (text === '' || PHONE.isValue(text)) return null
  const digits = text.replace(/\D/g, '')
  if (digits === '') return null
  let proposal: string
  if (text.startsWith('+')) {
    proposal = `+${digits}`
  } else {
    const code = country == null ? null : countryCode(country.trim())
    const calling = code === null ? undefined : CALLING_CODES[code]
    if (calling === undefined) return null
    proposal = `+${calling}${digits.replace(/^0+/, '')}`
  }
  return PHONE.isValue(proposal) ? proposal : null
}

/**
 * A phone Value taken apart: its calling code, the national number after it,
 * and the names of the phone's country. The phone's country is `country` when
 * its calling code is the phone's; otherwise it is the one country of the
 * closed list with that code, and none when several share it. A text that is
 * not a phone Value, or whose calling code the closed list does not hold, has
 * no parts.
 */
export function phoneParts(phone: string, country: string | null | undefined): PhoneParts | null {
  if (!PHONE.isValue(phone)) return null
  const digits = phone.slice(1)
  // Calling codes are prefix-free (ITU E.164), so at most one is a prefix.
  const callingCode = [...new Set(Object.values(CALLING_CODES))].find((c) => digits.startsWith(c))
  if (callingCode === undefined || digits.length === callingCode.length) return null
  const stored = country == null ? null : countryCode(country.trim())
  const sharing = Object.keys(CALLING_CODES).filter((code) => CALLING_CODES[code] === callingCode)
  const own = stored !== null && CALLING_CODES[stored] === callingCode ? stored
    : sharing.length === 1 ? sharing[0]! : null
  return { callingCode, nationalNumber: digits.slice(callingCode.length), countryNames: own === null ? [] : countryNames(own) }
}

/**
 * The parts a city typeahead's Fill needs: every name of the stored country in
 * both languages, by the closed list. A country outside the list is named by
 * its own text alone, and no country stored gives no names.
 */
export function cityParts(country: string | null | undefined): CityParts {
  const stored = country?.trim() ?? ''
  if (stored === '') return { countryNames: [] }
  const code = countryCode(stored)
  return { countryNames: code === null ? [stored] : countryNames(code) }
}
