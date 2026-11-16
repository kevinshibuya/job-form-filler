import type { AtsModule, WidgetKind } from '@jff/shared'
import { isUploadWording, labelText } from './labelText'

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
  | 'group-legend' | 'group-aria' | 'module' | 'none'

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
  /** A file picker with no label, whose only label source offered its upload
   *  button's words ("Attach"). The junk filter keeps such a hidden picker as
   *  it kept it while the wording was its label (#46). */
  uploadWordingOnly?: true
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
  const t = clean(labelText(best.label))
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
  const t = clean(labelText(label))
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
      const t = clean(labelText(child))
      if (t !== '') return { text: t, source: 'climb', element: child }
    }
    node = node.parentElement
    levels++
  }
  return null
}

/**
 * The ATS module's label rule, tried before anything the page declares (spec
 * #41). It records `module` as its source on the binding; the source does not
 * travel with the Field. Null when the module has no rule or the rule finds
 * nothing, and the generic order runs as it would with no module.
 */
function moduleLabelFor(el: Element, mod: AtsModule | undefined): LabelBinding | null {
  const found = mod?.labelRule?.(el) ?? null
  return found === null ? null : { text: found.text, source: 'module', element: found.element }
}

/**
 * The label of the nearest labelled group around a file picker, when the
 * picker is the only Control in it (#46). Greenhouse labels its upload with
 * the button's words and puts the question on the group around it, so the
 * group's label comes before the picker's own. A group that holds two file
 * pickers, or a picker and any other Control, gives its label to neither.
 */
function fileGroupLabelFor(el: Element): LabelBinding | null {
  for (let group = el.parentElement?.closest('fieldset, [role="group"]') ?? null;
    group !== null;
    group = group.parentElement?.closest('fieldset, [role="group"]') ?? null) {
    const label = group.tagName === 'FIELDSET' ? legendLabelOf(group) : ariaGroupLabel(group)
    if (label === null) continue
    return isSoleControl(group, el) ? label : null
  }
  return null
}

function legendLabelOf(fieldset: Element): LabelBinding | null {
  const legend = fieldset.querySelector('legend')
  const t = clean(legend === null ? '' : labelText(legend))
  return legend === null || t === '' ? null : { text: t, source: 'group-legend', element: legend }
}

function explicitLabelFor(el: Element): LabelBinding | null {
  if (el.id === '') return null
  const l = scopeOf(el).querySelector(`label[for="${escapeId(el.id)}"]`)
  const t = clean(l === null ? '' : labelText(l))
  return l === null || t === '' ? null : { text: t, source: 'explicit', element: l }
}

function ariaLabelFor(el: Element): LabelBinding | null {
  const aria = clean(el.getAttribute('aria-label'))
  return aria === '' ? null : { text: aria, source: 'aria-label', element: null }
}

function ariaLabelledByFor(el: Element): LabelBinding | null {
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy === null) return null
  const scope = scopeOf(el)
  const refs = labelledBy.split(/\s+/)
    .map((id) => scope.querySelector(`[id="${escapeId(id)}"]`))
    .filter((n): n is Element => n !== null)
  const t = clean(refs.map(labelText).join(' '))
  return t === '' ? null : { text: t, source: 'aria-labelledby', element: refs[0] ?? null }
}

function wrappingLabelFor(el: Element): LabelBinding | null {
  const wrapping = el.closest('label')
  const t = clean(wrapping === null ? '' : labelText(wrapping))
  return wrapping === null || t === '' ? null : { text: t, source: 'wrapping', element: wrapping }
}

function legendFor(el: Element): LabelBinding | null {
  const fieldset = el.closest('fieldset')
  const found = fieldset === null ? null : legendLabelOf(fieldset)
  return found === null ? null : { ...found, source: 'legend' }
}

function placeholderFor(el: Element): LabelBinding | null {
  const placeholder = clean(el.getAttribute('placeholder'))
  return placeholder === '' ? null : { text: placeholder, source: 'placeholder', element: null }
}

/** A Control's label: the first source, in order, that offers one. `mod` is
 *  the frame's ATS module: its label rule answers first for a Control that is
 *  a question by itself. A checkbox keeps its own text, so the rule is never
 *  asked for one. A file picker asks its group first, and passes over a
 *  source that offers only its upload button's words; with none left it has
 *  no label (#46). It never takes the legend of a fieldset it shares with
 *  other Controls (#55). A placeholder is the last source for every Control. */
export function labelFor(el: Element, mod?: AtsModule): LabelBinding {
  const kind = kindOf(el)
  const sources: ReadonlyArray<() => LabelBinding | null> = [
    () => (kind === 'checkbox' || kind === 'radiogroup' ? null : moduleLabelFor(el, mod)),
    () => (kind === 'file' ? fileGroupLabelFor(el) : null),
    () => explicitLabelFor(el),
    () => ariaLabelFor(el),
    () => ariaLabelledByFor(el),
    () => wrappingLabelFor(el),
    // #55: a file picker takes its fieldset's legend only through its group,
    // when it is the fieldset's only Control. A legend over many Controls
    // names none of the pickers in it.
    () => (kind === 'file' ? null : legendFor(el)),
    () => danglingLabelFor(el),
    () => nameForLabelFor(el),
    () => climbLabelFor(el),
    () => placeholderFor(el),
  ]
  let passedOver = false
  for (const source of sources) {
    const found = source()
    if (found === null) continue
    if (kind === 'file' && isUploadWording(found.text)) { passedOver = true; continue }
    return found
  }
  return passedOver ? { ...NO_BINDING, uploadWordingOnly: true } : NO_BINDING
}

/** A [role="group"] container's own label: its aria-label, then the text of
 *  its aria-labelledby targets. Null when neither yields text. */
export function ariaGroupLabel(group: Element): LabelBinding | null {
  const aria = clean(group.getAttribute('aria-label'))
  if (aria !== '') return { text: aria, source: 'group-aria', element: null }
  const labelledBy = group.getAttribute('aria-labelledby')
  if (labelledBy === null) return null
  const scope = scopeOf(group)
  const refs = labelledBy.split(/\s+/)
    .map((id) => scope.querySelector(`[id="${escapeId(id)}"]`))
    .filter((n): n is Element => n !== null)
  const t = clean(refs.map(labelText).join(' '))
  return t === '' ? null : { text: t, source: 'group-aria', element: refs[0] ?? null }
}

/**
 * The label of a WHOLE radio group. Never consults the wrapping <label> of an
 * individual radio: that is the OPTION's text ("Remote"), not the group's
 * ("Work model"). The ATS module's label rule first, then group-level signals
 * only: fieldset legend, then a [role="group"] container's aria-label /
 * aria-labelledby.
 */
export function groupLabelFor(el: Element, mod?: AtsModule): LabelBinding {
  const fromModule = moduleLabelFor(el, mod)
  if (fromModule !== null) return fromModule

  const legend = el.closest('fieldset')?.querySelector('legend') ?? null
  const legendText = clean(legend === null ? '' : labelText(legend))
  if (legend !== null && legendText !== '') return { text: legendText, source: 'group-legend', element: legend }

  const group = el.closest('[role="group"]')
  const aria = group === null ? null : ariaGroupLabel(group)
  if (aria !== null) return aria

  const dangling = danglingLabelFor(el)
  if (dangling !== null) return dangling

  const climbed = climbLabelFor(el)
  if (climbed !== null) return climbed

  return NO_BINDING
}

/** The visible label of one radio/option element. */
export function optionLabelOf(el: Element): string {
  const wrapping = el.closest('label')
  const t = clean(wrapping === null ? '' : labelText(wrapping))
  if (t !== '') return t
  if (el.id !== '') {
    const l = scopeOf(el).querySelector(`label[for="${escapeId(el.id)}"]`)
    const lt = clean(l === null ? '' : labelText(l))
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
