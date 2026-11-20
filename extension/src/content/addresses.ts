import { ADDRESS_SENTENCE_MAX, FRAME_ADDRESSES_MAX, isAddressShape, type AddressContext, type FoundAddress } from '@jff/shared'

/**
 * Address collection (spec #66). The page script of each frame reads the
 * addresses its own document shows, in the pass that enumerates its Fields:
 * every `mailto:` link, with its link text and subject, and every address in
 * the visible text, with the sentence around it. It reads the DOM and nothing
 * else: no network request, no AI call. An address the page writes as
 * "name at domain" is not one, by design.
 */

/** An address in running text. The domain ends on letters, so the full stop
 *  that closes a sentence stays out of it. */
const ADDRESS_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/

/** Elements whose text is not page text. */
const NOT_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG'])

/** Inline elements a sentence runs through: the sentence is read from the
 *  nearest ancestor that is none of these. */
const INLINE = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'FONT', 'I', 'KBD', 'LABEL', 'MARK',
  'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR',
])

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** By node type, not by class: a frame's nodes belong to its own window's classes. */
const isElement = (n: Node): n is Element => n.nodeType === Node.ELEMENT_NODE

/** The text cut to `max` characters around [start, end), marked where cut. */
function cutAround(text: string, start: number, end: number, max: number): string {
  if (text.length <= max) return text
  const room = Math.max(0, max - (end - start) - 2)
  let from = Math.max(0, start - Math.floor(room / 2))
  const to = Math.min(text.length, from + (end - start) + room)
  from = Math.max(0, to - (end - start) - room)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`.slice(0, max)
}

/** The sentence of `text` that holds [start, end), cut to the fixed length. A
 *  sentence ends at `.`, `!` or `?` followed by a space, so an address's own
 *  dots never end one. */
function sentenceAround(text: string, start: number, end: number): string {
  let from = 0
  for (const m of text.slice(0, start).matchAll(/[.!?]\s/g)) from = m.index + 2
  const after = /[.!?](?=\s|$)/.exec(text.slice(end))
  const to = after === null ? text.length : end + after.index + 1
  return cutAround(text.slice(from, to), start - from, end - from, ADDRESS_SENTENCE_MAX)
}

/** The recipients of a `mailto:` address, and its subject. Its `body`, `cc`
 *  and `bcc` are never read. */
function readMailto(href: string): { recipients: string[]; subject: string | null } {
  const rest = href.replace(/^\s*mailto:/i, '')
  const q = rest.indexOf('?')
  const path = q === -1 ? rest : rest.slice(0, q)
  const params = new URLSearchParams(q === -1 ? '' : rest.slice(q + 1))
  const decode = (s: string): string => { try { return decodeURIComponent(s) } catch { return s } }
  const recipients = [path, ...params.getAll('to')]
    .flatMap((part) => decode(part).split(','))
    .map((a) => a.trim())
    .filter(isAddressShape)
  const subject = params.get('subject')
  return { recipients, subject: subject === null || subject.trim() === '' ? null : subject }
}

/** Whether an element, or one of its ancestors, keeps its text off the screen. */
function hidden(el: Element): boolean {
  const view = el.ownerDocument.defaultView
  for (let e: Element | null = el; e !== null; e = e.parentElement) {
    if ((e as HTMLElement).hidden === true) return true
    if (view !== null) {
      const style = view.getComputedStyle(e)
      if (style.display === 'none' || style.visibility === 'hidden') return true
    }
  }
  return false
}

/** The nearest ancestor that is not inline: the block a sentence is read from. */
function blockOf(el: Element): Element {
  let e = el
  while (INLINE.has(e.tagName.toUpperCase()) && e.parentElement !== null) e = e.parentElement
  return e
}

const isMailto = (el: Element): boolean =>
  el.tagName.toUpperCase() === 'A' && /^\s*mailto:/i.test(el.getAttribute('href') ?? '')

/** The addresses in the text of a block, each with its sentence, in order. */
function addressesInBlock(block: Element, seen: Set<Element>): FoundAddress[] {
  if (seen.has(block)) return []
  seen.add(block)
  // The block's text without its mailto: links, which speak for themselves.
  const parts: string[] = []
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent ?? ''); return }
    if (!isElement(node)) return
    if (NOT_TEXT.has(node.tagName.toUpperCase()) || isMailto(node)) { parts.push(' '); return }
    if (node !== block && !INLINE.has(node.tagName.toUpperCase())) { parts.push(' '); return }
    for (const child of node.childNodes) walk(child)
  }
  walk(block)
  const text = collapse(parts.join(''))
  const out: FoundAddress[] = []
  // A fresh global copy: a shared global regex carries `lastIndex` from one
  // search into the next.
  for (const m of text.matchAll(new RegExp(ADDRESS_IN_TEXT.source, 'g'))) {
    const address = m[0]
    const at = m.index ?? 0
    if (!isAddressShape(address)) continue
    out.push({ address, context: { kind: 'text', sentence: sentenceAround(text, at, at + address.length) } })
  }
  return out
}

const keyOf = (f: FoundAddress): string => `${f.address.toLowerCase()}\u0000${JSON.stringify(f.context)}`

/**
 * The addresses `root` shows, in page order: each `mailto:` link's
 * recipients, one entry each, and each address in the visible text outside
 * those links. A repeat of the same address in the same context is reported
 * once, and a frame reports at most `FRAME_ADDRESSES_MAX`.
 */
export function collectAddresses(root: Document): FoundAddress[] {
  const body = root.body
  if (body === null) return []
  const found: FoundAddress[] = []
  const blocks = new Set<Element>()
  const walker = root.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      isElement(node) && NOT_TEXT.has(node.tagName.toUpperCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (isElement(node)) {
      if (!isMailto(node)) continue
      const { recipients, subject } = readMailto(node.getAttribute('href') ?? '')
      const linkText = collapse(node.textContent ?? '').slice(0, ADDRESS_SENTENCE_MAX)
      for (const address of recipients) found.push({ address, context: { kind: 'mailto', linkText, subject } satisfies AddressContext })
      continue
    }
    // A text node: only one that holds something shaped like an address costs
    // a look at its block and its visibility.
    const parent = node.parentElement
    if (parent === null || !ADDRESS_IN_TEXT.test(node.textContent ?? '')) continue
    const link = parent.closest('a[href]')
    if (link !== null && isMailto(link)) continue
    if (hidden(parent)) continue
    found.push(...addressesInBlock(blockOf(parent), blocks))
  }
  const seen = new Set<string>()
  const out: FoundAddress[] = []
  for (const f of found) {
    const key = keyOf(f)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
    if (out.length === FRAME_ADDRESSES_MAX) break
  }
  return out
}
