import { normalizeFactValue, type FieldKey } from './keys.js'
import { CALLING_CODES, RULE_TABLE, countryCode, yesNoOf, type RuleLanguage } from './ruleTable.js'

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
 * Only `relocate` (a yes or a no) and `phone` (international form) have a
 * typed form so far; every other key stores and answers its text as is.
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

const TYPED: Partial<Record<FieldKey, TypedForm>> = { relocate: YES_NO, phone: PHONE }

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
