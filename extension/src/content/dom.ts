import type { WidgetKind } from '@jff/shared'

type Scope = Document | ShadowRoot

/** The scope an element's id references resolve in (shadow roots are separate trees). */
export function scopeOf(el: Element): Scope {
  const root = el.getRootNode()
  return root instanceof ShadowRoot || root instanceof Document ? root : document
}

/**
 * Every element in the tree, piercing OPEN shadow roots. Plain querySelectorAll
 * cannot see into a shadow root, and custom career pages use them heavily.
 * Closed shadow roots are unreachable by design; countUnreachableWidgets reports
 * them so the panel can say "N unreachable widgets".
 */
export function walkElements(root: Scope): Element[] {
  const out: Element[] = []
  const visit = (scope: Scope): void => {
    for (const el of Array.from(scope.querySelectorAll('*'))) {
      out.push(el)
      if (el.shadowRoot !== null) visit(el.shadowRoot)
    }
  }
  visit(root)
  return out
}

/**
 * A custom element (its tag name contains a hyphen) that exposes no shadow root
 * AND renders no light-DOM children is almost certainly using a CLOSED shadow
 * root. That is the only signal available: closed roots are not observable.
 */
export function countUnreachableWidgets(root: Scope): number {
  let n = 0
  for (const el of walkElements(root)) {
    if (!el.tagName.includes('-')) continue
    if (el.shadowRoot !== null) continue
    if (el.childElementCount > 0) continue
    if ((el.textContent ?? '').trim() !== '') continue
    n++
  }
  return n
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim()
}

function escapeId(id: string): string {
  return id.replace(/"/g, '\\"')
}

/** Demographic/EEO wording. Lives here (not classify.ts) so the label heuristics
 *  and enumerate.ts can both test recovered label TEXT without importing
 *  classify.ts — dom.ts is the leaf of the content-layer import graph.
 *  classify.ts re-exports it, so every existing import path keeps working. */
export const DEMOGRAPHIC_RE =
  /eeo|equal employment|demographic|voluntary self|self-identif|veteran status|disability status|race\s*\/?\s*ethnicity|gender identity|autodeclara|raça|etnia|deficiência/i

const SKIPPED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

function isCombobox(el: Element): boolean {
  return el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox'
}

/** The widget kind of an element, or null when it is not an enumerable control.
 *  Moved here from enumerate.ts (logic unchanged) because the label heuristics
 *  need "is this an enumerable control?" and dom.ts may not import enumerate.ts. */
export function kindOf(el: Element): WidgetKind | null {
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

export type LabelSource =
  | 'explicit' | 'aria-label' | 'aria-labelledby' | 'wrapping' | 'legend'
  | 'dangling' | 'name-for' | 'climb' | 'placeholder'
  | 'group-legend' | 'group-aria' | 'none'

/**
 * A label binding, not just a string. `element` is the node whose textContent
 * supplied the text (null for attribute-sourced text): A2 reads its RAW
 * textContent + class for requiredness, A4 anchors the description search on
 * its parent wrapper.
 */
export interface LabelBinding {
  text: string | null
  source: LabelSource
  element: Element | null
}

const NO_BINDING: LabelBinding = { text: null, source: 'none', element: null }

/** Enumerable controls inside `scope`, with radios sharing a name collapsed to
 *  ONE unit. Without the collapse, the dangling-label rule and the climb would
 *  be structurally dead for radio groups (their wrapper always holds 2+ radios). */
function enumerableUnits(scope: Element): Element[] {
  const units: Element[] = []
  const seenRadioNames = new Set<string>()
  for (const el of Array.from(scope.querySelectorAll('*'))) {
    if (kindOf(el) === null) continue
    const name = el.getAttribute('name')
    if (el instanceof HTMLInputElement && el.type === 'radio' && name !== null && name !== '') {
      if (seenRadioNames.has(name)) continue
      seenRadioNames.add(name)
    }
    units.push(el)
  }
  return units
}

/** True when `target` is the SINGLE enumerable control inside `wrapper`
 *  (radios sharing target's name count as that single control). */
export function isSoleControl(wrapper: Element, target: Element): boolean {
  const units = enumerableUnits(wrapper)
  if (units.length !== 1) return false
  const u = units[0]!
  if (u === target) return true
  const tName = target.getAttribute('name')
  return target instanceof HTMLInputElement && target.type === 'radio'
    && u instanceof HTMLInputElement && u.type === 'radio'
    && tName !== null && tName !== '' && u.getAttribute('name') === tName
}

function ancestorDepth(el: Element, ancestor: Element): number {
  let d = 0
  let n: Element | null = el
  while (n !== null && n !== ancestor) { n = n.parentElement; d++ }
  return d
}

/**
 * Dangling-label repair (Ashby emits <label for="uuid"> where the uuid matches
 * no element id). Such a label binds to the control iff the control is the
 * single enumerable control inside the label's parent wrapper. Option labels
 * are structurally excluded: their `for` resolves (to the radio/checkbox id).
 * Multiple candidates: the NEAREST wrapper wins. body/documentElement are never
 * wrappers (mislabeling is worse than null).
 */
function danglingLabelFor(el: Element): LabelBinding | null {
  const scope = scopeOf(el)
  let best: { label: Element; depth: number } | null = null
  for (const label of Array.from(scope.querySelectorAll('label[for]'))) {
    const forId = label.getAttribute('for') ?? ''
    if (forId === '') continue
    if (scope.querySelector(`[id="${escapeId(forId)}"]`) !== null) continue // resolves: not dangling
    const wrapper = label.parentElement
    if (wrapper === null || wrapper === document.body || wrapper === document.documentElement) continue
    if (!wrapper.contains(el)) continue
    if (!isSoleControl(wrapper, el)) continue
    const depth = ancestorDepth(el, wrapper)
    if (best === null || depth < best.depth) best = { label, depth }
  }
  if (best === null) return null
  const t = clean(best.label.textContent)
  return t === '' ? null : { text: t, source: 'dangling', element: best.label }
}

/** React's htmlFor≈name convention: a DANGLING label whose `for` equals the
 *  control's `name` exactly (Ashby yes/no checkboxes carry the field uuid as
 *  their name). */
function nameForLabelFor(el: Element): LabelBinding | null {
  const name = el.getAttribute('name')
  if (name === null || name === '') return null
  const scope = scopeOf(el)
  if (scope.querySelector(`[id="${escapeId(name)}"]`) !== null) return null // resolves: belongs to that element
  const label = scope.querySelector(`label[for="${escapeId(name)}"]`)
  if (label === null) return null
  // Spec A1 scopes name==for to the label's WRAPPER: a document-wide lookup can
  // bind a newsletter label at the top of the page to an ATS control far below.
  const wrapper = label.parentElement
  if (wrapper === null || !wrapper.contains(el)) return null
  const t = clean(label.textContent)
  return t === '' ? null : { text: t, source: 'name-for', element: label }
}

const CLIMB_MAX_LEVELS = 5

/**
 * Guarded ancestor climb — the last resort before placeholder. Every stop is
 * strict because a wrong label + recognizer means an unconfirmed auto-fill:
 * never past <form>, never across a shadow boundary (parentElement === null),
 * never past an ancestor holding another enumerable control, never
 * body/documentElement — and the boundary ancestor itself is NOT consulted.
 * Accepted children: <label>/<legend>/heading whose `for` (if any) does not
 * resolve to a control.
 */
function climbLabelFor(el: Element): LabelBinding | null {
  const scope = scopeOf(el)
  let node: Element | null = el.parentElement
  let levels = 0
  while (node !== null && levels < CLIMB_MAX_LEVELS) {
    if (node === document.body || node === document.documentElement) return null
    if (node.tagName === 'FORM') return null
    if (!isSoleControl(node, el)) return null // another control's territory: stop unconsulted
    for (const child of Array.from(node.children)) {
      if (!/^(LABEL|LEGEND|H1|H2|H3|H4|H5|H6)$/.test(child.tagName)) continue
      // A <label> that WRAPS a control is that OPTION's text, never the group's.
      if (child.tagName === 'LABEL' && Array.from(child.querySelectorAll('*')).some((d) => kindOf(d) !== null)) continue
      const forId = child.getAttribute('for')
      if (forId !== null && forId !== '') {
        const target = scope.querySelector(`[id="${escapeId(forId)}"]`)
        if (target !== null && kindOf(target) !== null) continue // that label belongs to a control
      }
      const t = clean(child.textContent)
      if (t !== '') return { text: t, source: 'climb', element: child }
    }
    node = node.parentElement
    levels++
  }
  return null
}

export function labelFor(el: Element): LabelBinding {
  const scope = scopeOf(el)

  if (el.id !== '') {
    const l = scope.querySelector(`label[for="${escapeId(el.id)}"]`)
    const t = clean(l?.textContent)
    if (l !== null && t !== '') return { text: t, source: 'explicit', element: l }
  }

  const aria = clean(el.getAttribute('aria-label'))
  if (aria !== '') return { text: aria, source: 'aria-label', element: null }

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const refs = labelledBy.split(/\s+/)
      .map((id) => scope.querySelector(`[id="${escapeId(id)}"]`))
      .filter((n): n is Element => n !== null)
    const t = clean(refs.map((n) => n.textContent ?? '').join(' '))
    if (t !== '') return { text: t, source: 'aria-labelledby', element: refs[0] ?? null }
  }

  const wrapping = el.closest('label')
  if (wrapping !== null) {
    const t = clean(wrapping.textContent)
    if (t !== '') return { text: t, source: 'wrapping', element: wrapping }
  }

  const legend = el.closest('fieldset')?.querySelector('legend') ?? null
  const legendText = clean(legend?.textContent)
  if (legend !== null && legendText !== '') return { text: legendText, source: 'legend', element: legend }

  const dangling = danglingLabelFor(el)
  if (dangling !== null) return dangling

  const nameFor = nameForLabelFor(el)
  if (nameFor !== null) return nameFor

  const climbed = climbLabelFor(el)
  if (climbed !== null) return climbed

  const placeholder = clean(el.getAttribute('placeholder'))
  if (placeholder !== '') return { text: placeholder, source: 'placeholder', element: null }

  return NO_BINDING
}

/**
 * The label of a WHOLE radio group. Never consults the wrapping <label> of an
 * individual radio: that is the OPTION's text ("Remote"), not the group's
 * ("Work model"). Group-level signals only: fieldset legend, then a
 * [role="group"] container's aria-label / aria-labelledby.
 */
export function groupLabelFor(el: Element): LabelBinding {
  const legend = el.closest('fieldset')?.querySelector('legend') ?? null
  const legendText = clean(legend?.textContent)
  if (legend !== null && legendText !== '') return { text: legendText, source: 'group-legend', element: legend }

  const group = el.closest('[role="group"]')
  if (group !== null) {
    const aria = clean(group.getAttribute('aria-label'))
    if (aria !== '') return { text: aria, source: 'group-aria', element: null }
    const labelledBy = group.getAttribute('aria-labelledby')
    if (labelledBy !== null) {
      const scope = scopeOf(group)
      const refs = labelledBy.split(/\s+/)
        .map((id) => scope.querySelector(`[id="${escapeId(id)}"]`))
        .filter((n): n is Element => n !== null)
      const t = clean(refs.map((n) => n.textContent ?? '').join(' '))
      if (t !== '') return { text: t, source: 'group-aria', element: refs[0] ?? null }
    }
  }

  const dangling = danglingLabelFor(el)
  if (dangling !== null) return dangling

  const climbed = climbLabelFor(el)
  if (climbed !== null) return climbed

  return NO_BINDING
}

/** The visible label of one radio/option element. */
export function optionLabelOf(el: Element): string {
  const wrapping = el.closest('label')
  const t = clean(wrapping?.textContent)
  if (t !== '') return t
  if (el.id !== '') {
    const l = scopeOf(el).querySelector(`label[for="${escapeId(el.id)}"]`)
    const lt = clean(l?.textContent)
    if (lt !== '') return lt
  }
  const aria = clean(el.getAttribute('aria-label'))
  if (aria !== '') return aria
  return clean(el.getAttribute('value'))
}

/**
 * A2: Ashby renders requiredness as a literal '*' in the label's raw text or as
 * a CSS-module class token (`_required_f7cvd_91`). Both live on the BINDING
 * element — clean() strips a trailing '*' from the returned text, which is why
 * the binding carries the element. Class-token matching survives CSS-module
 * hashing by convention, like classify.ts's regexes (accepted risk).
 */
export function requiredFromBinding(binding: LabelBinding): boolean {
  if (binding.element === null) return false
  if ((binding.element.textContent ?? '').includes('*')) return true
  const klass = binding.element.getAttribute('class') ?? ''
  return klass.split(/\s+/).some((token) =>
    /(^|[-_])required/i.test(token) && !/not[-_]?required/i.test(token))
}

export const DESCRIPTION_MAX_CHARS = 500

const DESCRIPTION_CLASS_RE = /description|help|hint/i
const DESCRIPTION_REJECT_RE = /error|invalid|validation/i

function normalizeText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

/** A candidate block is a description only if it is pure text-bearing: no form
 *  control anywhere in its subtree, no error/validation class. */
function isDescriptionCandidate(node: Element): boolean {
  if (DESCRIPTION_REJECT_RE.test(node.getAttribute('class') ?? '')) return false
  for (const d of Array.from(node.querySelectorAll('*'))) {
    if (kindOf(d) !== null) return false
  }
  return true
}

/**
 * A4: wrapper-scoped description capture. aria-describedby targets first; else
 * class-token blocks (/description|help|hint/i) anywhere inside the binding
 * element's parent wrapper — the dump shows both control-sibling and
 * control-uncle positions. Value is whitespace-normalized textContent only:
 * markup and hrefs are discarded by construction. Capped at 500 chars.
 */
export function descriptionFor(el: Element, binding: LabelBinding): string | null {
  const scope = scopeOf(el)

  const describedBy = el.getAttribute('aria-describedby')
  if (describedBy !== null) {
    const text = normalizeText(describedBy.split(/\s+/)
      .map((id) => scope.querySelector(`[id="${escapeId(id)}"]`))
      .filter((n): n is Element => n !== null && isDescriptionCandidate(n))
      .map((n) => n.textContent ?? '')
      .join(' '))
    if (text !== '') return text.slice(0, DESCRIPTION_MAX_CHARS)
  }

  const wrapper = binding.element?.parentElement ?? null
  if (wrapper === null) return null
  for (const node of Array.from(wrapper.querySelectorAll('*'))) {
    const klass = node.getAttribute('class') ?? ''
    if (!klass.split(/\s+/).some((t) => DESCRIPTION_CLASS_RE.test(t))) continue
    if (!isDescriptionCandidate(node)) continue
    const text = normalizeText(node.textContent)
    if (text !== '') return text.slice(0, DESCRIPTION_MAX_CHARS)
  }
  return null
}
