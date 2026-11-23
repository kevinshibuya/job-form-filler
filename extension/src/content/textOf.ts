/** What a reader sees of an element: never the source of a style, script,
 *  noscript or template. The one extractor every Job posting text source reads
 *  through, the live page's and a fetched posting page's alike.
 *
 *  `leaveOut` names elements inside `el` whose text does not count (ticket
 *  #100: the form regions). The live page is never touched: they are cut from
 *  a copy. */
export function textOf(el: Element, leaveOut: readonly Element[] = []): string {
  const copy = el.cloneNode(true) as Element
  const cut = leaveOut.filter((r) => r !== el && el.contains(r)).map((r) => inCopy(copy, pathFrom(el, r)))
  for (const n of [...cut, ...Array.from(copy.querySelectorAll('script, style, noscript, template'))]) n.remove()
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** The child indices that lead from `top` down to `el`, a descendant of it. */
function pathFrom(top: Element, el: Element): number[] {
  const path: number[] = []
  for (let node = el; node !== top; node = node.parentElement!) {
    path.unshift(Array.prototype.indexOf.call(node.parentElement!.children, node) as number)
  }
  return path
}

function inCopy(copy: Element, path: readonly number[]): Element {
  return path.reduce<Element>((node, i) => node.children[i]!, copy)
}
