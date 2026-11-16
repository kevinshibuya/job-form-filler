import { optionSetValue } from '@jff/shared'
import { kindOf, optionLabelOf, requiredFromBinding, scopeOf, type LabelBinding } from './dom'
import { labelText } from './labelText'

/**
 * Checkbox groups: checkboxes that share a name, or that sit under one group
 * label, are one Field with a multi-choice Control. Its label is the group's
 * question, its Options the boxes' labels in page order, and its Value the set
 * of ticked labels. A box that shares neither with another stays a lone
 * checkbox, which is a Consent checkbox.
 */
export interface CheckboxGroup {
  /** Every box of the group, in page order. The first carries the Field's fid. */
  boxes: HTMLInputElement[]
  /** The group's question. */
  binding: LabelBinding
}

/** Written on every box of a group, holding the group's fid, so Fill and the
 *  snapshot find the whole group from the box that carries the fid. */
export const GROUP_ATTR = 'data-jff-group'

const NO_BINDING: LabelBinding = { text: null, source: 'none', element: null }

/** An Option that reads as the user agreeing to or acknowledging something. */
const AGREEMENT_RE = /\b(agree|accept|consent|acknowledg|certif|authori[sz]e|confirm)\w*|\b(terms|privacy (policy|notice))\b/i

/**
 * Consent boxes a page happens to put under one fieldset or [role=group]: no
 * two share a name, and every Option reads as an agreement. They stay lone
 * Consent checkboxes, so a consent is never stored or ticked again on another
 * form. Boxes that share a name are a real multi-choice question whatever
 * they say.
 */
function isConsentCluster(members: HTMLInputElement[]): boolean {
  const names = members.map(nameOf).filter((n) => n !== '')
  if (new Set(names).size < names.length) return false
  return members.every((b) => AGREEMENT_RE.test(optionLabelOf(b)))
}

/** How far above a box the question may sit. Lever puts it six levels up. */
const QUESTION_MAX_LEVELS = 8

/** A label's text without the required mark pages append ("✱", "*"). */
function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').replace(/\s*[*✱]\s*$/, '').trim()
}

function escapeAttr(v: string): string {
  return v.replace(/"/g, '\\"')
}

function isBox(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === 'checkbox'
}

function nameOf(el: Element): string {
  return el.getAttribute('name') ?? ''
}

/** The group label a page writes for a group of controls: a fieldset legend, or
 *  a [role="group"] container's aria label. The container is the group. */
function declaredGroup(box: HTMLInputElement): { container: Element; binding: LabelBinding } | null {
  const fieldset = box.closest('fieldset')
  const legend = fieldset?.querySelector('legend') ?? null
  const legendText = legend === null ? '' : clean(labelText(legend))
  if (fieldset !== null && legend !== null && legendText !== '') {
    return { container: fieldset, binding: { text: legendText, source: 'group-legend', element: legend } }
  }
  const group = box.closest('[role="group"]')
  if (group === null) return null
  const aria = clean(group.getAttribute('aria-label'))
  if (aria !== '') return { container: group, binding: { text: aria, source: 'group-aria', element: null } }
  const refs = (group.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter((id) => id !== '')
    .map((id) => scopeOf(group).querySelector(`[id="${escapeAttr(id)}"]`))
    .filter((n): n is Element => n !== null)
  const text = clean(refs.map(labelText).join(' '))
  return text === '' ? null : { container: group, binding: { text, source: 'group-aria', element: refs[0] ?? null } }
}

/**
 * The question written above a box when nothing declares the group: the nearest
 * earlier sibling, of the box's own label or of an ancestor, that holds text and
 * no control. Lever lays a checkbox question out this way, the question in a
 * plain <div> beside the list of boxes.
 *
 * Earlier boxes of the same group are skipped on the way up: a sibling holding
 * only checkboxes of the box's name, or nameless ones, is a fellow Option. Any
 * other control means the climb has reached another question, and it stops.
 * It never climbs past the form or into document.body.
 */
function questionAbove(box: HTMLInputElement): Element | null {
  const name = nameOf(box)
  const fellow = (c: Element): boolean => isBox(c) && (name === '' || nameOf(c) === '' || nameOf(c) === name)
  // The box's own wrapping label is the Option's text, never the question.
  let node: Element = box.closest('label') ?? box
  for (let level = 0; level < QUESTION_MAX_LEVELS; level++) {
    for (let s = node.previousElementSibling; s !== null; s = s.previousElementSibling) {
      const controls = [s, ...Array.from(s.querySelectorAll('*'))].filter((d) => kindOf(d) !== null)
      if (controls.length > 0) {
        if (controls.every(fellow)) continue
        return null
      }
      // A <label for> that names a control is that control's label.
      const forId = s.tagName === 'LABEL' ? s.getAttribute('for') ?? '' : ''
      if (forId !== '') {
        const target = scopeOf(s).querySelector(`[id="${escapeAttr(forId)}"]`)
        if (target !== null && kindOf(target) !== null) continue
      }
      if (clean(s.textContent) !== '') return s
    }
    const parent = node.parentElement
    if (parent === null || parent.tagName === 'FORM' || parent === document.body || parent === document.documentElement) return null
    node = parent
  }
  return null
}

/** Union-find over boxes, so a name and a group label can each join boxes. */
class Groups {
  private parent = new Map<HTMLInputElement, HTMLInputElement>()
  constructor(boxes: HTMLInputElement[]) { for (const b of boxes) this.parent.set(b, b) }
  find(b: HTMLInputElement): HTMLInputElement {
    let r = b
    while (this.parent.get(r) !== r) r = this.parent.get(r)!
    this.parent.set(b, r)
    return r
  }
  union(a: HTMLInputElement, b: HTMLInputElement): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
  members(boxes: HTMLInputElement[]): Map<HTMLInputElement, HTMLInputElement[]> {
    const out = new Map<HTMLInputElement, HTMLInputElement[]>()
    for (const b of boxes) {
      const r = this.find(b)
      out.set(r, [...(out.get(r) ?? []), b])
    }
    return out
  }
}

function unionAll(groups: Groups, boxes: HTMLInputElement[]): void {
  for (const b of boxes.slice(1)) groups.union(boxes[0]!, b)
}

function bucket<K>(boxes: HTMLInputElement[], keyOf: (b: HTMLInputElement) => K | null): HTMLInputElement[][] {
  const out = new Map<K, HTMLInputElement[]>()
  for (const b of boxes) {
    const k = keyOf(b)
    if (k !== null) out.set(k, [...(out.get(k) ?? []), b])
  }
  return [...out.values()]
}

/**
 * Groups the page's checkboxes, `boxes` in page order. Returns the group of
 * every box that has one; a box absent from the map is a lone checkbox.
 *
 * A shared name joins boxes, and so does a declared group label. A question
 * found only by climbing joins a box to a group that a name or a declared
 * label already formed (Lever's nameless "Custom" pronoun box), but never makes
 * a group out of lone boxes: two consent boxes under one heading stay two
 * Consent checkboxes. So do consent boxes under one declared label
 * (isConsentCluster).
 */
export function groupCheckboxes(boxes: HTMLInputElement[]): Map<HTMLInputElement, CheckboxGroup> {
  const groups = new Groups(boxes)
  const declared = new Map(boxes.map((b) => [b, declaredGroup(b)]))
  for (const same of bucket(boxes, (b) => (nameOf(b) === '' ? null : nameOf(b)))) unionAll(groups, same)
  for (const same of bucket(boxes, (b) => declared.get(b)?.container ?? null)) unionAll(groups, same)

  const climbed = new Map(boxes.map((b) => [b, declared.get(b) === null ? questionAbove(b) : null]))
  for (const same of bucket(boxes, (b) => climbed.get(b) ?? null)) {
    const sizes = groups.members(boxes)
    if (same.some((b) => (sizes.get(groups.find(b))?.length ?? 0) >= 2)) unionAll(groups, same)
  }

  const out = new Map<HTMLInputElement, CheckboxGroup>()
  for (const members of groups.members(boxes).values()) {
    if (members.length < 2 || isConsentCluster(members)) continue
    const group: CheckboxGroup = { boxes: members, binding: questionOf(members, declared, climbed) }
    for (const b of members) out.set(b, group)
  }
  return out
}

/** The group's question: a declared group label first, else the question
 *  found above its first box that has one. */
function questionOf(
  members: HTMLInputElement[],
  declared: Map<HTMLInputElement, { binding: LabelBinding } | null>,
  climbed: Map<HTMLInputElement, Element | null>,
): LabelBinding {
  for (const b of members) {
    const d = declared.get(b)
    if (d != null) return d.binding
  }
  for (const b of members) {
    const el = climbed.get(b) ?? null
    if (el !== null) return { text: clean(el.textContent), source: 'climb', element: el }
  }
  return NO_BINDING
}

const REQUIRED_CLASS_RE = /(^|[-_])required/i

/** A group is required when any box says so or its question carries a
 *  required mark: "*", "✱", or a required class on the label or inside it. */
export function groupRequired(group: CheckboxGroup): boolean {
  if (group.boxes.some((b) => b.required || b.getAttribute('aria-required') === 'true')) return true
  const el = group.binding.element
  if (el === null) return false
  if (requiredFromBinding(group.binding) || (el.textContent ?? '').includes('✱')) return true
  return Array.from(el.querySelectorAll('[class]')).some((d) =>
    (d.getAttribute('class') ?? '').split(/\s+/).some((t) => REQUIRED_CLASS_RE.test(t) && !/not[-_]?required/i.test(t)))
}

/** The Options of a group: its boxes' labels, in page order. */
export function groupOptions(boxes: HTMLInputElement[]): string[] {
  return boxes.map(optionLabelOf)
}

/** The group's Value as text: the ticked boxes' labels, or null when none is. */
export function groupValue(boxes: HTMLInputElement[]): string | null {
  const labels = boxes.filter((b) => b.checked).map(optionLabelOf)
  return labels.length === 0 ? null : optionSetValue(labels)
}

/** Every box of the group whose fid a box carries, in page order; null when the
 *  box is not part of a group. */
export function groupBoxesOf(el: Element): HTMLInputElement[] | null {
  const fid = el.getAttribute(GROUP_ATTR)
  if (fid === null) return null
  return Array.from(scopeOf(el).querySelectorAll<HTMLInputElement>(`input[type="checkbox"][${GROUP_ATTR}="${escapeAttr(fid)}"]`))
}
