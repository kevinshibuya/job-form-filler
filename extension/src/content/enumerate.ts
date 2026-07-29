import type { EnumField, WidgetKind } from '@jff/shared'
import {
  countUnreachableWidgets, DEMOGRAPHIC_RE, descriptionFor, groupLabelFor, isSoleControl, kindOf,
  labelFor, optionLabelOf, requiredFromBinding, scopeOf, walkElements, type LabelBinding,
} from './dom'

export interface Measure {
  display: string
  visibility: string
  ariaHidden: boolean
  width: number
  height: number
  /** The visually-hidden recipe: a ≤1px box, or clip/clip-path collapse. */
  clipped: boolean
}
export type MeasureFn = (el: Element) => Measure

/** Pure so the recipe is unit-testable (jsdom computes 0×0 rects; the real
 *  computation is exercised by the Playwright fixtures in later slices). */
export function isClipped(width: number, height: number, clip: string, clipPath: string): boolean {
  return (width <= 1 && height <= 1)
    || /^rect\(\s*0(?:px)?\s*[,\s]\s*0(?:px)?\s*[,\s]\s*0(?:px)?\s*[,\s]\s*0(?:px)?\s*\)$/.test(clip)
    || /^inset\(\s*(?:50|100)%\s*\)$/.test(clipPath)
}

export const defaultMeasure: MeasureFn = (el) => {
  const st = window.getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  return {
    display: st.display,
    visibility: st.visibility,
    ariaHidden: el.getAttribute('aria-hidden') === 'true',
    width: rect.width,
    height: rect.height,
    clipped: isClipped(rect.width, rect.height, st.clip ?? '', st.clipPath ?? ''),
  }
}

/** Named bounds: they encode "a segmented control, not a toolbar", so fixtures
 *  and code cannot drift apart. */
export const CHOICE_MIN_BUTTONS = 2
export const CHOICE_MAX_BUTTONS = 5
export const CHOICE_MAX_OPTION_CHARS = 30

export interface ChoiceDetection { wrapper: Element; buttons: HTMLButtonElement[]; options: string[] }

export function selfHidden(m: Measure): boolean {
  return m.display === 'none' || m.visibility === 'hidden' || m.clipped
}

/**
 * A3 structural detection, from the hidden input outward: the nearest
 * button-holding ancestor is THE wrapper; it qualifies iff it holds 2–5 short
 * buttons and no enumerable control besides the input itself (radios sharing
 * the input's name count as that one control). Structural only — the caller
 * gates on selfHidden(measure). EXPORTED because B1's fillChoice must re-detect
 * with this same function, so filler and enumerator can never disagree.
 */
export function detectChoice(el: Element): ChoiceDetection | null {
  if (!(el instanceof HTMLInputElement) || (el.type !== 'checkbox' && el.type !== 'radio')) return null
  let wrapper: Element | null = el.parentElement
  let levels = 0
  while (wrapper !== null && levels < 5) {
    if (wrapper.tagName === 'FORM' || wrapper === document.body || wrapper === document.documentElement) return null
    const buttons = Array.from(wrapper.querySelectorAll('button'))
    if (buttons.length > 0) {
      if (buttons.length < CHOICE_MIN_BUTTONS || buttons.length > CHOICE_MAX_BUTTONS) return null
      const options = buttons.map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim())
      if (options.some((t) => t === '' || t.length > CHOICE_MAX_OPTION_CHARS)) return null
      if (!isSoleControl(wrapper, el)) return null
      return { wrapper, buttons, options }
    }
    wrapper = wrapper.parentElement
    levels++
  }
  return null
}

export interface EnumerateOptions {
  root: Document
  epoch: number
  measure?: MeasureFn
  /** Injected in Task 14; defaults to "nothing is demographic" so this task stands alone. */
  isDemographic?: (el: Element) => boolean
}

const FID_ATTR = 'data-jff-fid'

let currentEpoch = -1
export const getEpoch = (): number => currentEpoch
export const setEpoch = (e: number): void => { currentEpoch = e }

// kindOf / isCombobox / SKIPPED_INPUT_TYPES moved to ./dom (unchanged logic):
// the label-recovery heuristics need "is this an enumerable control?" and dom.ts
// must not import enumerate.ts.

/** Options of an ARIA combobox: aria-owns/aria-controls, then a sibling listbox. */
function comboboxOptions(el: Element): string[] {
  const scope = scopeOf(el)
  const owns = el.getAttribute('aria-owns') ?? el.getAttribute('aria-controls')
  let listbox: Element | null = null
  if (owns !== null) {
    const first = owns.split(/\s+/)[0]
    if (first !== undefined) listbox = scope.querySelector(`[id="${first.replace(/"/g, '\\"')}"]`)
  }
  if (listbox === null) listbox = el.parentElement?.querySelector('[role="listbox"]') ?? null
  if (listbox === null) return []
  return Array.from(listbox.querySelectorAll('[role="option"]'))
    .map((o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((t) => t !== '')
}

function currentValueOf(el: Element, kind: WidgetKind): string | null {
  if (kind === 'select') {
    const sel = el as HTMLSelectElement
    const opt = sel.selectedOptions[0]
    // A "Select…" placeholder (empty value or disabled) is a prompt, not a
    // page-sourced value: it must resolve through the normal waterfall.
    if (opt === undefined || opt.value === '' || opt.disabled) return null
    const t = (opt.textContent ?? '').trim()
    return t === '' ? null : t
  }
  if (kind === 'checkbox') return (el as HTMLInputElement).checked ? 'true' : null
  if (kind === 'file') return null
  if (kind === 'combobox') {
    const v = (el as HTMLInputElement).value
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
    const t = (el.textContent ?? '').trim()
    return t === '' ? null : t
  }
  const v = (el as HTMLInputElement | HTMLTextAreaElement).value
  return typeof v === 'string' && v !== '' ? v : null
}

/** Native requiredness OR the ATS conventions carried by the bound label. */
function requiredOf(el: Element, binding: LabelBinding): boolean {
  return (el as HTMLInputElement).required === true
    || el.getAttribute('aria-required') === 'true'
    || requiredFromBinding(binding)
}

export function enumerateFields(opts: EnumerateOptions): { fields: EnumField[]; unreachableWidgets: number } {
  const measure = opts.measure ?? defaultMeasure
  const isDemographic = opts.isDemographic ?? (() => false)
  setEpoch(opts.epoch)

  // A re-scan must not leave stale stamps behind: old handles die with the epoch,
  // and a leftover fid would let elementByFid resolve the wrong element.
  for (const el of walkElements(opts.root)) el.removeAttribute(FID_ATTR)

  const fields: EnumField[] = []
  const radioGroups = new Map<string, EnumField>()
  let fid = 0

  for (const el of walkElements(opts.root)) {
    const kind = kindOf(el)
    if (kind === null) continue

    const m = measure(el)
    // HONEST visibility for every kind, file included: the blanket file
    // exemption moved to the panel filter (junk.ts), which keeps hidden file
    // inputs only when they carry a resolvable label (A8 adds scoring).
    // `clipped` counts: the visually-hidden recipe (1px box / clip:rect(0 0 0 0))
    // is how ATS pages hide real controls, so a clipped control is NOT visible.
    const visible = !(m.ariaHidden || m.display === 'none' || m.visibility === 'hidden' || m.clipped)

    if (kind === 'radiogroup') {
      const name = el.getAttribute('name')
      const groupKey = name === null || name === '' ? `__fid_${fid}` : name
      const existing = radioGroups.get(groupKey)
      if (existing !== undefined) {
        // A choice group is complete at its first member: the buttons are the
        // options, so later same-name radios contribute nothing.
        if (existing.kind === 'choice') continue
        const optionLabel = optionLabelOf(el)
        existing.options.push(optionLabel)
        if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') existing.required = true
        if ((el as HTMLInputElement).checked) existing.currentValue = optionLabel
        continue
      }

      // groupLabelFor, NOT labelFor: the wrapping <label> of the first radio is
      // that OPTION's text ("Remote"), never the group's ("Work model").
      const binding = groupLabelFor(el)
      const choice = selfHidden(m) ? detectChoice(el) : null
      const group: EnumField = choice !== null
        ? {
            frameId: -1, fid, epoch: opts.epoch,
            label: binding.text, name, idAttr: el.id === '' ? null : el.id,
            // Options are the BUTTON texts verbatim (i18n-safe), never the
            // radio option labels and never boolean-mapped.
            kind: 'choice', options: choice.options,
            required: requiredOf(el, binding),
            visible,
            // Which button a checked hidden radio maps to is not observable
            // here; null is honest and routes through the normal waterfall.
            currentValue: null,
            demographic: isDemographic(el) || DEMOGRAPHIC_RE.test(binding.text ?? ''),
            description: descriptionFor(el, binding) ?? undefined,
          }
        : {
            frameId: -1, fid, epoch: opts.epoch,
            label: binding.text, name, idAttr: el.id === '' ? null : el.id,
            kind: 'radiogroup', options: [optionLabelOf(el)],
            required: requiredOf(el, binding),
            visible, currentValue: (el as HTMLInputElement).checked ? optionLabelOf(el) : null,
            demographic: isDemographic(el) || DEMOGRAPHIC_RE.test(binding.text ?? ''),
            description: descriptionFor(el, binding) ?? undefined,
          }
      // Only the FIRST member carries data-jff-fid; the filler re-finds the
      // other members through the shared name (fill.ts) or, for choice, the
      // buttons structurally via detectChoice (B1).
      el.setAttribute(FID_ATTR, String(fid))
      radioGroups.set(groupKey, group)
      fields.push(group)
      fid++
      continue
    }

    if (kind === 'checkbox' && selfHidden(m)) {
      const choice = detectChoice(el)
      if (choice !== null) {
        const binding = labelFor(el)
        el.setAttribute(FID_ATTR, String(fid))
        fields.push({
          frameId: -1, fid, epoch: opts.epoch,
          label: binding.text, name: el.getAttribute('name'), idAttr: el.id === '' ? null : el.id,
          kind: 'choice', options: choice.options,
          required: requiredOf(el, binding),
          visible, currentValue: null,
          demographic: isDemographic(el) || DEMOGRAPHIC_RE.test(binding.text ?? ''),
          description: descriptionFor(el, binding) ?? undefined,
        })
        fid++
        continue
      }
    }

    let options: string[] = []
    if (kind === 'select') {
      options = Array.from((el as HTMLSelectElement).options)
        .map((o) => (o.textContent ?? '').trim())
        .filter((t) => t !== '')
    } else if (kind === 'combobox') {
      options = comboboxOptions(el)
    }

    const binding = labelFor(el)
    el.setAttribute(FID_ATTR, String(fid))
    fields.push({
      frameId: -1, fid, epoch: opts.epoch,
      label: binding.text, name: el.getAttribute('name'), idAttr: el.id === '' ? null : el.id,
      kind, options,
      required: requiredOf(el, binding),
      visible, currentValue: currentValueOf(el, kind),
      demographic: isDemographic(el) || DEMOGRAPHIC_RE.test(binding.text ?? ''),
      description: descriptionFor(el, binding) ?? undefined,
      accept: kind === 'file' ? el.getAttribute('accept') ?? undefined : undefined,
    })
    fid++
  }

  return { fields, unreachableWidgets: countUnreachableWidgets(opts.root) }
}

/** Resolve a handle back to a live element, piercing open shadow roots. */
export function elementByFid(root: Document, fid: number): Element | null {
  for (const el of walkElements(root)) {
    if (el.getAttribute(FID_ATTR) === String(fid)) return el
  }
  return null
}
