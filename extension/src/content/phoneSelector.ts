import { norm, type PhoneParts } from '@jff/shared'
import { kindOf } from './dom'
import type { OptionMatch } from './optionMatch'

/*
 * The country selector beside a phone box is part of the phone Field: it is
 * set from the phone's country code and never offered a Value of its own.
 * Recognising it is generic, by its structure beside a phone box, and never
 * knowledge about one ATS (ADR 0007). Enumeration and Fill both read it through
 * `phoneSelectorsOf`, so the two can never disagree about what is attached.
 */

/** A phone box: a tel input, or a text input whose autocomplete, name or id says phone. */
export function isPhoneControl(el: Element): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false
  if (el.type === 'tel') return true
  if (el.type !== 'text') return false
  if (/^tel(-national)?$/i.test((el.getAttribute('autocomplete') ?? '').trim().split(/\s+/).pop() ?? '')) return true
  return /\bphone|telefone|celular|\bmobile/i.test(`${el.name} ${el.id}`)
}

/** What can open a list of countries: a native select, a combobox, anything with a popup. */
const SELECTOR = 'select, [role="combobox"], [aria-haspopup]:not([aria-haspopup="false"])'

/** The elements a control points at through aria-controls and aria-owns. */
function controlled(el: Element): Element[] {
  const root = el.getRootNode() as Document | ShadowRoot
  return [el.getAttribute('aria-controls'), el.getAttribute('aria-owns')]
    .flatMap((v) => (v ?? '').split(/\s+/))
    .filter((id) => id !== '')
    .flatMap((id) => { const t = root.querySelector(`[id="${id.replace(/"/g, '\\"')}"]`); return t === null ? [] : [t] })
}

/** The enumerable controls under `scope`, the scope itself excluded. */
const controlsIn = (scope: Element): Element[] =>
  Array.from(scope.querySelectorAll('*')).filter((el) => kindOf(el) !== null)

/**
 * A flag dropdown inside the phone box's wrapper. The wrapper is an ancestor
 * of the phone box below the Field's own label (it holds no label or legend);
 * the selector is the first element in it that opens a list. Every other
 * control in the wrapper must belong to that selector (inside it, or inside
 * what it controls, as a flag list's search box does), or the wrapper is not a
 * phone box's and nothing is attached.
 */
function flagSelector(phone: HTMLInputElement): { selector: Element; internals: Element[] } | null {
  let wrapper = phone.parentElement
  for (let depth = 0; wrapper !== null && depth < 3; depth++, wrapper = wrapper.parentElement) {
    if (wrapper.tagName === 'FORM' || wrapper.tagName === 'BODY' || wrapper.querySelector('label, legend') !== null) return null
    const selector = Array.from(wrapper.querySelectorAll(SELECTOR)).find((s) => s !== phone && !s.contains(phone))
    if (selector === undefined) continue
    const owned = [selector, ...controlled(selector)]
    const internals = controlsIn(wrapper).filter((c) => c !== phone)
    if (internals.some((c) => !owned.some((o) => o.contains(c)))) return null
    return { selector, internals }
  }
  return null
}

/**
 * A country dropdown paired with the phone box: the closest fieldset or group
 * around the phone box holds exactly one other control a person reaches (one
 * hidden from assistive technology does not count), and it is a dropdown.
 */
function pairedSelector(phone: HTMLInputElement, flagInternals: readonly Element[]): Element | null {
  const group = phone.closest('fieldset, [role="group"]')
  if (group === null) return null
  const others = controlsIn(group).filter((c) =>
    c !== phone && !flagInternals.includes(c) && c.getAttribute('aria-hidden') !== 'true')
  if (others.length !== 1) return null
  const only = others[0]!
  const kind = kindOf(only)
  return kind === 'select' || kind === 'combobox' ? only : null
}

export interface AttachedSelectors {
  /** The selectors a Fill sets, the paired dropdown before the flag dropdown. */
  selectors: Element[]
  /** Every enumerable control that belongs to them: none is a Field. */
  internals: Element[]
}

/** The country selectors attached to a phone box; null for any other element or a phone box with none. */
export function phoneSelectorsOf(el: Element): AttachedSelectors | null {
  if (!isPhoneControl(el)) return null
  const flag = flagSelector(el)
  const paired = pairedSelector(el, flag?.internals ?? [])
  const selectors = [paired, flag?.selector ?? null].filter((s): s is Element => s !== null)
  if (selectors.length === 0) return null
  return { selectors, internals: [...(paired === null ? [] : [paired]), ...(flag?.internals ?? [])] }
}

/** An Option's country name: its text with any calling code beside it ("+1", "(+351)") taken out. */
export function optionCountryName(text: string): string {
  return text.replace(/\(?\+\s?\d+\)?/g, ' ').replace(/\s+/g, ' ').trim()
}

const pickOne = (hits: number[]): OptionMatch =>
  hits.length === 1 ? { found: 'one', index: hits[0]! } : hits.length === 0 ? { found: 'none' } : { found: 'many' }

/**
 * The selector Option for the phone's country: the one that names the country
 * by any of its names, with or without a calling code beside the name. When no
 * country is given or no Option names it, the one Option that carries the
 * calling code. Two Options either way is no pick: Fill never guesses.
 */
export function pickCountryOption(options: readonly string[], parts: PhoneParts): OptionMatch {
  const names = new Set(parts.countryNames.map(norm))
  const byName = options.flatMap((o, i) => (names.has(norm(optionCountryName(o))) ? [i] : []))
  if (byName.length > 0) return pickOne(byName)
  const code = new RegExp(`\\+\\s?${parts.callingCode}(?!\\d)`)
  return pickOne(options.flatMap((o, i) => (code.test(o) ? [i] : [])))
}
