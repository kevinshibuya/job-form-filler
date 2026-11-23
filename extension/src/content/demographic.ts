import { asksAboutAccommodation } from '@jff/shared'
import { DEMOGRAPHIC_RE } from './dom'

/** Lower case with the accents stripped, so Portuguese wording matches with or
 *  without them ("gênero" and "genero" fold to the same text). */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** A pattern that matches only as a word of its own: no letter or digit may
 *  touch either end, so "race" never fires inside "embrace" or "Bitrace". */
function asWords(wordings: readonly string[]): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${wordings.join('|')})(?![\\p{L}\\p{N}])`, 'u')
}

/**
 * The closed list of protected attributes, English and Portuguese, as folded
 * regex sources. A space matches any run of whitespace.
 */
const PROTECTED_WORDINGS: readonly string[] = [
  // gender
  'gender', 'genero', 'sexo',
  // race. "race condition" is a programming question, not a protected attribute.
  'race(?!\\s+conditions?(?![\\p{L}\\p{N}]))', 'racial', 'raca', 'cor\\s+ou\\s+raca',
  // ethnicity
  'ethnicity', 'ethnic', 'etnia', 'etnico',
  // Hispanic or Latino
  'hispanic', 'latino', 'latina', 'latinx', 'hispanico',
  // veteran
  'veteran', 'veterano',
  // disability
  'disability', 'disabled', 'deficiencia', 'pcd',
  // sexual orientation
  'sexual\\s+orientation', 'orientacao\\s+sexual',
  // transgender
  'transgender', 'transgenero', 'pessoa\\s+trans',
  // neurodivergent
  'neurodivergent', 'neurodivergence', 'neurodiverse', 'neurodivergente', 'neurodiversidade',
]

const PROTECTED_RE = asWords(PROTECTED_WORDINGS)

/** A Field asking for pronouns is answered from the stored pronouns Value. */
const PRONOUNS_RE = asWords(['pronouns?', 'pronomes?'])

/**
 * Whether a Field is a Demographic Field, from its own label and from the
 * section test (`isDemographic` in classify.ts), which the caller runs.
 *
 * Pronouns and accommodation needs are never Demographic Fields, under a
 * demographic heading too. Otherwise the section, the phrases the label test
 * has always known, or a protected attribute named in the label make it one.
 */
export function isDemographicField(label: string | null, inDemographicSection: boolean): boolean {
  const text = label ?? ''
  const folded = fold(text)
  // A question about accommodation needs is the user's to answer (shared/src/accommodation.ts).
  if (PRONOUNS_RE.test(folded) || asksAboutAccommodation(text)) return false
  return inDemographicSection || DEMOGRAPHIC_RE.test(text) || PROTECTED_RE.test(folded)
}
