import type { EnumField, WidgetKind } from '@jff/shared'
import { countUnreachableWidgets, groupLabelFor, labelFor, optionLabelOf, scopeOf, walkElements } from './dom'

export interface Measure {
  display: string
  visibility: string
  ariaHidden: boolean
  width: number
  height: number
}
export type MeasureFn = (el: Element) => Measure

export const defaultMeasure: MeasureFn = (el) => {
  const st = window.getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  return {
    display: st.display,
    visibility: st.visibility,
    ariaHidden: el.getAttribute('aria-hidden') === 'true',
    width: rect.width,
    height: rect.height,
  }
}

export interface EnumerateOptions {
  root: Document
  epoch: number
  measure?: MeasureFn
  /** Injected in Task 14; defaults to "nothing is demographic" so this task stands alone. */
  isDemographic?: (el: Element) => boolean
}

const FID_ATTR = 'data-jff-fid'
const SKIPPED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

let currentEpoch = -1
export const getEpoch = (): number => currentEpoch
export const setEpoch = (e: number): void => { currentEpoch = e }

function isCombobox(el: Element): boolean {
  return el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox'
}

function kindOf(el: Element): WidgetKind | null {
  if (isCombobox(el)) return 'combobox'
  const tag = el.tagName.toLowerCase()
  if (tag === 'select') return 'select'
  if (tag === 'textarea') return 'textarea'
  if (tag !== 'input') return null
  const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
  if (SKIPPED_INPUT_TYPES.has(type)) return null
  if (type === 'radio') return 'radiogroup'
  if (type === 'checkbox') return 'checkbox'
  if (type === 'file') return 'file'
  return 'text'
}

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
    const t = (opt?.textContent ?? '').trim()
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
    const visible = kind === 'file'
      ? true // Greenhouse hides the real file input behind a dropzone button
      : !(m.ariaHidden || m.display === 'none' || m.visibility === 'hidden')

    if (kind === 'radiogroup') {
      const name = el.getAttribute('name')
      const groupKey = name === null || name === '' ? `__fid_${fid}` : name
      const existing = radioGroups.get(groupKey)
      const optionLabel = optionLabelOf(el)
      const checked = (el as HTMLInputElement).checked
      if (existing !== undefined) {
        existing.options.push(optionLabel)
        if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') existing.required = true
        if (checked) existing.currentValue = optionLabel
        continue
      }
      const group: EnumField = {
        frameId: -1, fid, epoch: opts.epoch,
        // groupLabelFor, NOT labelFor: the wrapping <label> of the first radio is
        // that OPTION's text ("Remote"), never the group's ("Work model").
        label: groupLabelFor(el), name, idAttr: el.id === '' ? null : el.id,
        kind: 'radiogroup', options: [optionLabel],
        required: (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true',
        visible, currentValue: checked ? optionLabel : null,
        demographic: isDemographic(el),
      }
      // Only the FIRST radio of a group carries data-jff-fid; the filler re-finds
      // the other members through the shared name attribute (fill.ts).
      el.setAttribute(FID_ATTR, String(fid))
      radioGroups.set(groupKey, group)
      fields.push(group)
      fid++
      continue
    }

    let options: string[] = []
    if (kind === 'select') {
      options = Array.from((el as HTMLSelectElement).options)
        .map((o) => (o.textContent ?? '').trim())
        .filter((t) => t !== '')
    } else if (kind === 'combobox') {
      options = comboboxOptions(el)
    }

    el.setAttribute(FID_ATTR, String(fid))
    fields.push({
      frameId: -1, fid, epoch: opts.epoch,
      label: labelFor(el), name: el.getAttribute('name'), idAttr: el.id === '' ? null : el.id,
      kind, options,
      required: (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true',
      visible, currentValue: currentValueOf(el, kind),
      demographic: isDemographic(el),
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
