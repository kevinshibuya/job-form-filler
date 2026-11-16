import { norm, type CityParts } from '@jff/shared'
import type { OptionMatch } from './optionMatch'

/*
 * A city typeahead is typed the city alone, and among the results it returns
 * the Fill picks the one that names both the city and the stored country
 * (ticket #32). Several cities share a name, so the city by itself is no pick.
 */

/** A text as its words: lower case, accents kept, split at anything not a letter or digit. */
const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '')

/** True when `phrase` appears in `text` as whole words, in order: "US" is not inside "Massachusetts". */
function containsPhrase(text: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > text.length) return false
  for (let i = 0; i + phrase.length <= text.length; i++) {
    if (phrase.every((w, j) => text[i + j] === w)) return true
  }
  return false
}

const pickOne = (hits: number[]): OptionMatch =>
  hits.length === 1 ? { found: 'one', index: hits[0]! } : hits.length === 0 ? { found: 'none' } : { found: 'many' }

/**
 * The result for the stored city: the one Option that contains the city and
 * any of the country's names, each as whole words. With no country names, only
 * an Option equal to the city alone. Several, or none, is no pick: the Fill
 * never guesses between two cities of the same name.
 */
export function pickCityOption(options: readonly string[], city: string, parts: CityParts): OptionMatch {
  const cityWords = words(city)
  if (cityWords.length === 0) return { found: 'none' }
  if (parts.countryNames.length === 0) {
    return pickOne(options.flatMap((o, i) => (norm(o) === norm(city) ? [i] : [])))
  }
  const countries = parts.countryNames.map(words).filter((w) => w.length > 0)
  return pickOne(options.flatMap((o, i) => {
    const text = words(o)
    return containsPhrase(text, cityWords) && countries.some((c) => containsPhrase(text, c)) ? [i] : []
  }))
}
