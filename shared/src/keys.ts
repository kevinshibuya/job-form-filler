// The CLOSED set of factual field keys. The mapping LLM may only choose from this
// list; anything outside it is structurally rejected (anti-fabrication invariant).
// There is deliberately NO subjective key (e.g. "whyInterested") — subjective
// questions resolve to `custom` and go through the human-reviewed [Generate] flow.

export const PROFILE_KEYS = [
  'firstName', 'lastName', 'fullName', 'preferredName',
  'email', 'phone', 'location', 'linkedin', 'github', 'portfolio',
] as const

export const ANSWER_BANK_KEYS = [
  'workAuth', 'sponsorshipNeeded', 'relocate', 'salary',
  'notice', 'earliestStart', 'remotePreference', 'pronouns',
] as const

export const FIELD_KEYS = [...PROFILE_KEYS, ...ANSWER_BANK_KEYS] as const

export type ProfileKey = (typeof PROFILE_KEYS)[number]
export type AnswerBankKey = (typeof ANSWER_BANK_KEYS)[number]
export type FieldKey = ProfileKey | AnswerBankKey

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
