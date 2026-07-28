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

export function labelFor(el: Element): string | null {
  const scope = scopeOf(el)

  if (el.id !== '') {
    const l = scope.querySelector(`label[for="${escapeId(el.id)}"]`)
    const t = clean(l?.textContent)
    if (t !== '') return t
  }

  const aria = clean(el.getAttribute('aria-label'))
  if (aria !== '') return aria

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const t = clean(labelledBy.split(/\s+/)
      .map((id) => scope.querySelector(`[id="${escapeId(id)}"]`)?.textContent ?? '')
      .join(' '))
    if (t !== '') return t
  }

  const wrapping = el.closest('label')
  if (wrapping !== null) {
    const t = clean(wrapping.textContent)
    if (t !== '') return t
  }

  const legend = el.closest('fieldset')?.querySelector('legend')
  const legendText = clean(legend?.textContent)
  if (legendText !== '') return legendText

  const placeholder = clean(el.getAttribute('placeholder'))
  if (placeholder !== '') return placeholder

  return null
}

/**
 * The label of a WHOLE radio group. Never consults the wrapping <label> of an
 * individual radio: that is the OPTION's text ("Remote"), not the group's
 * ("Work model"). Group-level signals only: fieldset legend, then a
 * [role="group"] container's aria-label / aria-labelledby.
 */
export function groupLabelFor(el: Element): string | null {
  const legend = el.closest('fieldset')?.querySelector('legend')
  const legendText = clean(legend?.textContent)
  if (legendText !== '') return legendText

  const group = el.closest('[role="group"]')
  if (group !== null) {
    const aria = clean(group.getAttribute('aria-label'))
    if (aria !== '') return aria
    const labelledBy = group.getAttribute('aria-labelledby')
    if (labelledBy !== null) {
      const scope = scopeOf(group)
      const t = clean(labelledBy.split(/\s+/)
        .map((id) => scope.querySelector(`[id="${escapeId(id)}"]`)?.textContent ?? '')
        .join(' '))
      if (t !== '') return t
    }
  }
  return null
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
