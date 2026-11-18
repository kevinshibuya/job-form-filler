/** What a reader sees of an element: never the source of a style, script,
 *  noscript or template. The one extractor every Job posting text source reads
 *  through, the live page's and a fetched posting page's alike. */
export function textOf(el: Element): string {
  const copy = el.cloneNode(true) as Element
  for (const n of Array.from(copy.querySelectorAll('script, style, noscript, template'))) n.remove()
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}
