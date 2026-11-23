/**
 * The form region (spec #98, ticket #100): where a page's Fields are. Its text
 * never counts as Job posting text when the heuristic reads the page.
 *
 * For the Controls that share a form element, it is the smallest element that
 * holds them all, which is never larger than that form element. For the
 * Controls outside any form element, it is the smallest element that holds them
 * all. A page may have several regions.
 */

/** The element a node hangs from, stepping out of a shadow root to its host. */
function parentOf(el: Element): Element | null {
  const parent = el.parentNode
  if (parent instanceof ShadowRoot) return parent.host
  return parent instanceof Element ? parent : null
}

/** The form element around a Control, through any shadow root it is drawn in. */
function formOf(el: Element): Element | null {
  for (let node: Element | null = el; node !== null; node = parentOf(node)) {
    if (node.tagName === 'FORM') return node
  }
  return null
}

/** The smallest element that holds every one of `els`. */
function smallestHolder(els: readonly Element[]): Element {
  const first = els[0]!
  const chain: Element[] = []
  for (let node: Element | null = first; node !== null; node = parentOf(node)) chain.push(node)
  let depth = 0
  for (const el of els.slice(1)) {
    const onChain = new Set(chain.slice(depth))
    let node: Element | null = el
    while (node !== null && !onChain.has(node)) node = parentOf(node)
    // Controls of one document always meet at its document element.
    if (node === null) return chain[chain.length - 1]!
    depth = chain.indexOf(node)
  }
  return chain[depth]!
}

/** The form regions of the Controls an Enumeration found and the user can see.
 *  A Control no longer in the document draws no region. */
export function formRegions(controls: readonly Element[]): Element[] {
  const byForm = new Map<Element | null, Element[]>()
  for (const control of controls) {
    if (!control.isConnected) continue
    const form = formOf(control)
    byForm.set(form, [...(byForm.get(form) ?? []), control])
  }
  return [...byForm.values()].map(smallestHolder)
}

/** Whether a region is the whole document: then the heuristic gives nothing,
 *  since a wrong text is worse than none. */
export function coversDocument(region: Element): boolean {
  const doc = region.ownerDocument
  return region === doc.documentElement || region === doc.body
}
