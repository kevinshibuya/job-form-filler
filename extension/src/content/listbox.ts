import { scopeOf } from './dom'

/*
 * Which listbox belongs to a dropdown. A Scan never opens one (ADR 0009); a
 * Fill opens it and reads its Options through these two functions.
 */

const escAttr = (s: string): string => s.replace(/"/g, '\\"')

/** The control's OWN scope first (an open shadow root), then the document —
 *  shadow-DOM walking is a standing no-regression constraint, and ids inside a
 *  shadow root are invisible to `document.querySelector`. The document is still
 *  consulted because real widgets portal their listbox to `<body>`. */
function listboxScopes(root: Document, el: Element): (Document | ShadowRoot)[] {
  const scope = scopeOf(el)
  return scope === root ? [root] : [scope as ShadowRoot, root]
}

/**
 * The listbox ATTRIBUTION rule fillCombobox reads Options through: a
 * listbox belongs to the control iff the control points at it
 * (aria-owns/aria-controls) or it appeared AFTER our interaction (`before` =
 * the listboxes mounted pre-click). The document-wide "any listbox" fallback is
 * exactly the cross-combobox bug the spec kills — never add it back. Both
 * lookups run over the control's scope AND the document, in that order.
 */
export function attributableListbox(root: Document, el: Element, before: ReadonlySet<Element>): Element | null {
  const scopes = listboxScopes(root, el)
  const owns = el.getAttribute('aria-owns') ?? el.getAttribute('aria-controls')
  if (owns !== null) {
    const first = owns.split(/\s+/)[0]
    if (first !== undefined && first !== '') {
      for (const s of scopes) {
        const found = s.querySelector(`[id="${escAttr(first)}"]`)
        if (found !== null) return found
      }
    }
  }
  for (const s of scopes) {
    for (const lb of Array.from(s.querySelectorAll('[role="listbox"]'))) {
      if (!before.has(lb)) return lb
    }
  }
  return null
}

/** The pre-interaction listbox set, over the SAME scopes attribution searches —
 *  a shadow listbox missing from `before` would be misread as "appeared after
 *  our click". */
export function mountedListboxes(root: Document, el: Element): Set<Element> {
  const out = new Set<Element>()
  for (const s of listboxScopes(root, el)) {
    for (const lb of Array.from(s.querySelectorAll('[role="listbox"]'))) out.add(lb)
  }
  return out
}
