import { norm } from '@jff/shared'

/** Which of a Control's Options a Value picks: exactly one, none, or several. */
export type OptionMatch = { found: 'one'; index: number } | { found: 'none' } | { found: 'many' }

/**
 * The one Option equal to the Value or to one of its candidate words (the
 * rule table's, sent with the Fill). Equality is `norm`, the comparison every
 * Fill uses: case and spacing ignored, accents kept, never a substring. None,
 * or more than one Option, is no pick: Fill never guesses between two.
 */
export function matchOption(
  options: readonly string[], value: string, candidates: readonly string[] = [],
): OptionMatch {
  const wanted = new Set([value, ...candidates].map(norm))
  const hits: number[] = []
  options.forEach((o, i) => { if (wanted.has(norm(o))) hits.push(i) })
  if (hits.length === 1) return { found: 'one', index: hits[0]! }
  return hits.length === 0 ? { found: 'none' } : { found: 'many' }
}
