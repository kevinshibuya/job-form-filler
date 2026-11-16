// The CLOSED set of factual field keys. The mapping LLM may only choose from this
// list; anything outside it is structurally rejected (anti-fabrication invariant).
// There is deliberately NO subjective key (e.g. "whyInterested") — subjective
// questions resolve to `custom` and go through the human-reviewed [Generate] flow.

export const PROFILE_KEYS = [
  'firstName', 'lastName', 'fullName', 'preferredName',
  'email', 'phone', 'location', 'city', 'region', 'country',
  'linkedin', 'github', 'portfolio', 'currentCompany', 'currentTitle',
] as const

export const ANSWER_BANK_KEYS = [
  'workAuth', 'sponsorshipNeeded', 'relocate', 'salary',
  'notice', 'earliestStart', 'remotePreference', 'pronouns',
] as const

export const FIELD_KEYS = [...PROFILE_KEYS, ...ANSWER_BANK_KEYS] as const

export type ProfileKey = (typeof PROFILE_KEYS)[number]
export type AnswerBankKey = (typeof ANSWER_BANK_KEYS)[number]
export type FieldKey = ProfileKey | AnswerBankKey

/**
 * What kind of thing a Known key holds. The type decides which Controls the key
 * may answer (host/src/resolve/controlKinds.ts). A `place` is a city, a region
 * or a country; `location` is not one: it stays the one-line display text for a
 * free-text location box. A `place_list` is a list of countries: `workAuth`,
 * which answers yes/no questions about the countries a label names.
 * `sponsorshipNeeded` is a yes or a no derived from `workAuth`, never stored.
 * An `amount` is a salary: an amount with its currency and period. A
 * `per_language` text holds one Value for English and one for Portuguese.
 */
export const VALUE_TYPES = ['text', 'link', 'phone', 'yes_no', 'place', 'place_list', 'amount', 'per_language'] as const
export type ValueType = (typeof VALUE_TYPES)[number]

export const VALUE_TYPE_OF: Readonly<Record<FieldKey, ValueType>> = {
  firstName: 'text', lastName: 'text', fullName: 'text', preferredName: 'text',
  email: 'text', phone: 'phone', location: 'text',
  city: 'place', region: 'place', country: 'place',
  linkedin: 'link', github: 'link', portfolio: 'link',
  currentCompany: 'text', currentTitle: 'text',
  workAuth: 'place_list', sponsorshipNeeded: 'yes_no', relocate: 'yes_no',
  salary: 'amount', notice: 'per_language', earliestStart: 'per_language', remotePreference: 'per_language',
  pronouns: 'text',
}

const FIELD_KEY_SET: ReadonlySet<string> = new Set<string>(FIELD_KEYS)
const PROFILE_KEY_SET: ReadonlySet<string> = new Set<string>(PROFILE_KEYS)

export function isFieldKey(s: string): s is FieldKey {
  return FIELD_KEY_SET.has(s)
}

export function isProfileKey(s: string): s is ProfileKey {
  return PROFILE_KEY_SET.has(s)
}

// A fact is a single-line value: a name, a URL, a notice period. Anything that
// arrives with newlines in it is prose that took a wrong turn, so every write
// path normalises before storing and refuses what is still too long after.
export const FACT_MAX_CHARS = 500

export function normalizeFactValue(v: string): string {
  return v.replace(/\s+/g, ' ').trim()
}
