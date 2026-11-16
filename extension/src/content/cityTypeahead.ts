import { norm, type CityParts } from '@jff/shared'
import type { OptionMatch } from './optionMatch'

/*
 * A city typeahead is typed the city alone, and among the results it returns
 * the Fill picks the one that names both the city and the stored country
 * (ticket #32). Several cities share a name, so the city by itself is no pick;
 * among several in the same country, the stored region decides.
 */

/** A text as its words: lower case, accents folded, split at anything not a letter or digit. */
const words = (s: string): string[] =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '')

/** True when `phrase` appears in `text` as whole words, in order: "US" is not inside "Massachusetts". */
function containsPhrase(text: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > text.length) return false
  for (let i = 0; i + phrase.length <= text.length; i++) {
    if (phrase.every((w, j) => text[i + j] === w)) return true
  }
  return false
}

const sameWords = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((w, i) => w === b[i])

const pickOne = (hits: number[]): OptionMatch =>
  hits.length === 1 ? { found: 'one', index: hits[0]! } : hits.length === 0 ? { found: 'none' } : { found: 'many' }

/**
 * The result for the stored city: the one Option whose leading part (before
 * the first comma or parenthesis) is the city and whose rest names any of the
 * country's names, each as whole words. Several such Options are told apart by
 * the stored region: the one that also names it. With no country names, only
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
  const hits = options.flatMap((o, i) => {
    const cut = o.search(/[,(]/)
    if (cut === -1 || !sameWords(words(o.slice(0, cut)), cityWords)) return []
    const rest = words(o.slice(cut))
    return countries.some((c) => containsPhrase(rest, c)) ? [i] : []
  })
  const region = words(parts.region ?? '')
  if (hits.length > 1 && region.length > 0) {
    const inRegion = hits.filter((i) => containsPhrase(words(options[i]!.slice(options[i]!.search(/[,(]/))), region))
    if (inRegion.length === 1) return pickOne(inRegion)
  }
  return pickOne(hits)
}
