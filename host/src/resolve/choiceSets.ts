import { norm, optionSetLabels, optionSetValue } from '@jff/shared'

/**
 * How a stored set of Option labels meets the Options a checkbox group offers.
 *
 * - `all`: every stored label equals an offered Option.
 * - `some`: some do and some do not.
 * - `none`: no stored label equals an offered Option.
 *
 * Two labels are equal under `norm`, the comparison the Fill of a group uses.
 * `value` is made of the page's own Options, in page order and in the page's
 * wording, never the stored spelling; it is null when nothing matched. A Value
 * written in a text box has no newline, so it is a set of one label.
 */
export interface OptionSetMatch {
  match: 'all' | 'some' | 'none'
  value: string | null
}

export function matchOptionSet(stored: string, options: readonly string[]): OptionSetMatch {
  const wanted = new Set(optionSetLabels(stored).map(norm))
  const picked = options.filter((o) => wanted.has(norm(o)))
  if (picked.length === 0) return { match: 'none', value: null }
  const offered = new Set(picked.map(norm))
  const every = [...wanted].every((w) => offered.has(w))
  return { match: every ? 'all' : 'some', value: optionSetValue(picked) }
}

/** The one offered Option equal to a stored Known key Value, or null. */
export function optionEqualTo(stored: string, options: readonly string[]): string | null {
  const wanted = norm(stored)
  return options.find((o) => norm(o) === wanted) ?? null
}
