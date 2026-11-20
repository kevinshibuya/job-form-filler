/**
 * The cleaning code (spec #41): what turns a page into something that may leave
 * the tab. It works on any document: the page script's copy of the live page,
 * or a document the fixture command builds in Node. Pure DOM, no file system
 * and no browser extension calls.
 *
 * Two steps:
 *  - cleanForPrivacy: drops what carries no question and empties what the
 *    applicant typed, ticked or chose, and every address. The page keeps its
 *    structure.
 *  - cutToFixture: the fixture's own cuts. The form and its ancestors only, the
 *    Job posting's prose replaced, the Company named "Acme".
 *  - cutToPosting: the same for a Job posting page. The posting's element and
 *    its ancestors only, every word of its prose replaced, the Company named
 *    "Acme".
 *  - cutToEmail: the same for a page that applies by email. The posting, its
 *    mailto: links and its addresses with their ancestors, each address
 *    replaced whole by a numbered placeholder.
 *
 * Private strings, real e-mail addresses and credentials are replaced on the
 * serialised page by privateStrings.mjs, which every caller shares.
 */

import { ATS_LIST, companyFromTitle, companySlugFrom } from './ats.js'
import { JOB_TEXT_MIN } from './jobText.js'

export const FIXTURE_COMPANY = 'Acme'
export const PLACEHOLDER_PROSE = 'Placeholder text where the Job posting described the role.'
export const PLACEHOLDER_HEADING = 'Placeholder heading'
/** The domain every placeholder address of the email cut is on. */
export const PLACEHOLDER_ADDRESS_DOMAIN = 'example.org'


const SHOW_COMMENT = 0x80
const SHOW_TEXT = 0x4
const SHOW_ELEMENT = 0x1

const VALUELESS_INPUTS = new Set(['submit', 'button', 'reset', 'image'])
const NOT_CONTROLS = new Set(['hidden', 'submit', 'button', 'reset', 'image'])
/** What Enumeration reads as a Control, a combobox drawn on any element
 *  included: a listing page's locale switcher is a button with that role (#53). */
const CONTROL = 'input, select, textarea, [role="combobox"], [aria-haspopup="listbox"]'

/** Elements that carry no question: code, styling, pictures, icons, embeds. */
const DROPPED = 'script, style, link, meta, base, noscript, template, img, svg, picture, source, iframe, object, embed, canvas, video, audio'

/** Attributes whose whole value is an address. */
const ADDRESS_ATTRS = new Set(['action', 'href', 'src', 'srcset', 'formaction', 'poster', 'xlink:href', 'background', 'cite', 'data', 'ping', 'longdesc', 'codebase', 'manifest'])
const ADDRESS_VALUE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/|\.\.?\/)|:\/\//i
const URL_IN_TEXT = /(?:https?:)?\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})[^\s"'<>)]*/gi
const BOARD_PATH = /\/jobs\/\d+/gi
const HOST = /(?<![\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?![\w-])/gi
/** An e-mail address, as the private-strings rules read one. */
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const MAILTO = /^\s*mailto:/i

/** Containers the ATSes put a Job posting's description in. Never one holding a Control. */
const POSTING_PROSE = [
  '[class*="job-description" i]',
  '[id*="job-description" i]',
  '[class*="job__description" i]',
  '[class*="job_description" i]',
  '[class*="posting-description" i]',
  '[data-qa*="job-description" i]',
  '[class*="descricao" i]',
].join(', ')

/** Containers a Job posting sits in: every tier the page script's heuristic
 *  looks in (extension/src/content/jobpost.ts). */
const POSTING_CONTAINERS = [
  '[class*="job-description" i]', '[id*="job-description" i]', '[class*="job_description" i]', '[id*="job_description" i]',
  '[data-testid*="description" i]', '[class*="descricao" i]',
  '[class*="job-post" i]', '[id*="job-post" i]', '[class*="posting" i]', '[class*="vaga" i]',
  'article', 'main', '[role="main"]',
].join(', ')

/** A page's own wording rather than the posting's prose: a short button or
 *  link that sits outside running text, such as "Apply for this job". */
const UI_WORDING_MAX = 40
const RUNNING_TEXT = 'p, li, dd, td, blockquote'
const HEADING = 'h1, h2, h3, h4, h5, h6'

/** A Job posting id as an ATS writes one into an address: a UUID, or its start. */
const POSTING_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]*/gi

/** A board on the Company's own site, `/<slug>/jobs/<id>`, which belongs to no ATS. */
const RELATIVE_BOARD_PATH = /^\/([a-z0-9_-]+)\/jobs\/\d+/i
const BOARD_WORDS = new Set(['embed', 'jobs', 'boards', 'job-boards', 'api'])
const LEGAL_SUFFIX = /[,\s]+(?:inc\.?|llc|ltd\.?|limited|gmbh|s\.?a\.?|ltda\.?|corp\.?|co\.?)$/i

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every node of `kind` under `root`, collected before any is changed. */
function nodesOf(doc: Document, root: Node, kind: number): Node[] {
  const walker = doc.createTreeWalker(root, kind)
  const nodes: Node[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  return nodes
}

/** Drops scripts, styles, pictures, frames and comments, empties every typed
 *  Value, unticks every box, clears every selection and empties every
 *  attribute that holds an address. Every other element stays where it was.
 *  With `keepMailto`, an `href` that is a mailto: link stays for the email
 *  cut, which replaces its addresses; the page script never passes it. */
export function cleanForPrivacy(doc: Document, { keepMailto = false }: { keepMailto?: boolean } = {}): void {
  for (const el of Array.from(doc.querySelectorAll(DROPPED))) el.remove()
  for (const comment of nodesOf(doc, doc.documentElement, SHOW_COMMENT)) comment.parentNode?.removeChild(comment)

  for (const input of Array.from(doc.querySelectorAll('input'))) {
    const type = (input.getAttribute('type') ?? 'text').toLowerCase()
    input.removeAttribute('checked')
    if (input.checked) input.checked = false
    if (VALUELESS_INPUTS.has(type) || type === 'checkbox' || type === 'radio') continue
    // A hidden input keeps its name but not its value: that is where session
    // and CSRF tokens travel.
    input.removeAttribute('value')
    // What was typed lives in the property, not the attribute.
    if (input.value !== '') input.value = ''
  }
  for (const area of Array.from(doc.querySelectorAll('textarea'))) {
    area.textContent = ''
    if (area.value !== '') area.value = ''
  }
  for (const option of Array.from(doc.querySelectorAll('option'))) {
    option.removeAttribute('selected')
    if (option.selected) option.selected = false
  }

  for (const el of [doc.documentElement, ...Array.from(doc.documentElement.querySelectorAll('*'))]) {
    for (const { name, value } of Array.from(el.attributes)) {
      if (keepMailto && name === 'href' && MAILTO.test(value)) continue
      if (ADDRESS_ATTRS.has(name) || (name.startsWith('data-') && ADDRESS_VALUE.test(value))) {
        el.setAttribute(name, '')
      } else if (name === 'style' && /url\(/i.test(value)) {
        el.setAttribute(name, value.replace(/url\([^)]*\)/gi, 'url()'))
      }
    }
  }
}

/** The Company's names as this page spells them: the title and board address
 *  each ATS on the list writes, a board on the Company's own site, and the
 *  caller's. `addresses` are read as the page's own: a Capture keeps its tab's
 *  address beside a page the privacy step has already emptied of them.
 *  Longest first. Read it before cleaning, which drops the head. */
export function companyNames(doc: Document, extra: readonly string[] = [], addresses: readonly string[] = []): string[] {
  const names = new Set<string>()
  const add = (name: string | null | undefined): void => {
    const trimmed = (name ?? '').replace(/\s+/g, ' ').trim()
    if (trimmed.length < 2) return
    names.add(trimmed)
    const bare = trimmed.replace(LEGAL_SUFFIX, '').trim()
    if (bare.length >= 2) names.add(bare)
  }
  for (const ats of ATS_LIST) {
    const fromTitle = companyFromTitle(ats, doc.title)
    if (fromTitle !== null) {
      add(fromTitle)
      break
    }
  }
  add(doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content'))
  const allAddresses = [
    doc.querySelector('meta[property="og:url"]')?.getAttribute('content'),
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    ...Array.from(doc.querySelectorAll('form')).map((form) => form.getAttribute('action')),
    ...addresses,
  ]
  for (const address of allAddresses) {
    if (!address) continue
    for (const ats of ATS_LIST) add(companySlugFrom(ats, address))
    const slug = RELATIVE_BOARD_PATH.exec(address)?.[1]
    if (slug && !BOARD_WORDS.has(slug.toLowerCase())) add(slug)
  }
  for (const name of extra) add(name)
  return [...names].sort((a, b) => b.length - a.length)
}

function isControl(el: Element): boolean {
  if (el.tagName === 'INPUT' && NOT_CONTROLS.has((el.getAttribute('type') ?? 'text').toLowerCase())) return false
  if (/recaptcha/i.test(el.getAttribute('name') ?? '')) return false
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (/display\s*:\s*none/i.test(node.getAttribute('style') ?? '')) return false
  }
  return true
}

/** The application form, or the smallest element that holds every Control. */
function formRoot(doc: Document): Element | null {
  const controls = Array.from(doc.body.querySelectorAll(CONTROL)).filter(isControl)
  const forms = Array.from(doc.querySelectorAll('form'))
    .map((form) => ({ form, count: controls.filter((c) => form.contains(c)).length }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count)
  if (forms[0] !== undefined) return forms[0].form
  const first = controls[0]
  if (first === undefined) return null
  let root = first.parentElement ?? doc.body
  while (root !== doc.body && !controls.every((c) => root.contains(c))) root = root.parentElement ?? doc.body
  return root
}

/** Drops every node that is neither `root`, inside it, nor one of its ancestors. */
function cutTo(doc: Document, root: Element, titled: string): void {
  for (let keep: Element = root; keep !== doc.documentElement; ) {
    const parent: Element | null = keep.parentElement
    if (parent === null) break
    for (const sibling of Array.from(parent.childNodes)) if (sibling !== keep) sibling.remove()
    keep = parent
  }
  freshHead(doc, titled)
}

/** Replaces whatever the root holds besides the body with a head that has a
 *  charset and `titled` and nothing else. */
function freshHead(doc: Document, titled: string): void {
  for (const child of Array.from(doc.documentElement.childNodes)) if (child !== doc.body) child.remove()
  const head = doc.createElement('head')
  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  const title = doc.createElement('title')
  title.textContent = titled
  head.append(charset, title)
  doc.documentElement.insertBefore(head, doc.body)
}

function scrubText(text: string, companies: readonly string[], ids: boolean): string {
  let out = text.replace(URL_IN_TEXT, (_, host: string) => host).replace(BOARD_PATH, '/jobs')
  if (ids) out = out.replace(POSTING_ID, 'posting-id')
  // A host that spells the Company inside a longer word (its careers site, its
  // mail domain) is the Company too.
  out = out.replace(HOST, (host) => (companies.some((name) => host.toLowerCase().includes(name.toLowerCase())) ? 'example.com' : host))
  for (const name of companies) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'), FIXTURE_COMPANY)
  }
  return out
}

function scrubAttributes(el: Element, companies: readonly string[], ids: boolean): void {
  for (const { name, value } of Array.from(el.attributes)) {
    const clean = scrubText(value, companies, ids)
    if (clean !== value) el.setAttribute(name, clean)
  }
}

/** Names each of `companies` "Acme" and every address in text by its host, in
 *  every attribute and text node of the page; with `ids`, Job posting ids too. */
function scrubPage(doc: Document, companies: readonly string[], ids: boolean): void {
  for (const el of Array.from(doc.body.querySelectorAll('*'))) scrubAttributes(el, companies, ids)
  scrubAttributes(doc.body, companies, ids)
  scrubAttributes(doc.documentElement, companies, ids)
  for (const node of nodesOf(doc, doc.body, SHOW_TEXT)) {
    const text = node as Text
    const clean = scrubText(text.data, companies, ids)
    if (clean !== text.data) text.data = clean
  }
}

/** What a reader sees of an element: never a script's, a style's or a template's source. */
function readableText(el: Element): string {
  const copy = el.cloneNode(true) as Element
  for (const n of Array.from(copy.querySelectorAll('script, style, noscript, template'))) n.remove()
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The fixture's own cuts, on a page cleanForPrivacy has cleaned: keeps the
 * application form and its ancestors and nothing else of the page, gives it a
 * fresh head, replaces the Job posting's prose with placeholder text, and
 * names each of `companies` "Acme" and every address in text by its host.
 * False, and the page untouched, when it holds no form and no Control.
 */
export function cutToFixture(doc: Document, companies: readonly string[]): boolean {
  const root = formRoot(doc)
  if (root === null) return false
  cutTo(doc, root, `Application form at ${FIXTURE_COMPANY}`)

  for (const prose of Array.from(root.querySelectorAll(POSTING_PROSE))) {
    if (!prose.isConnected || prose.querySelector(CONTROL) !== null) continue
    const p = doc.createElement('p')
    p.textContent = PLACEHOLDER_PROSE
    prose.replaceChildren(p)
  }

  scrubPage(doc, companies, false)
  return true
}

/** The element that holds the Job posting: of the containers the page script's
 *  heuristic looks in, the one with the most text, at least the minimum. The
 *  outermost wins a tie, so the posting comes with all of its sections. Null
 *  when no container holds that much. */
export function postingRoot(doc: Document): Element | null {
  let best: { el: Element; length: number } | null = null
  for (const el of Array.from(doc.body.querySelectorAll(POSTING_CONTAINERS))) {
    const length = readableText(el).length
    if (length < JOB_TEXT_MIN) continue
    if (best === null || length > best.length) best = { el, length }
  }
  return best?.el ?? null
}

function isUiWording(text: Text): boolean {
  const parent = text.parentElement
  if (parent === null || text.data.trim().length > UI_WORDING_MAX) return false
  const control = parent.closest('a, button, [role="button"]')
  return control !== null && control.closest(RUNNING_TEXT) === null
}

/** `text` with every run of words around a match of `keep` replaced by
 *  `placeholder`, and each match left in its place. */
function replaceAround(text: string, placeholder: string, keep: RegExp | null): string {
  if (keep === null) return placeholder
  const parts: string[] = []
  let last = 0
  for (const match of text.matchAll(keep)) {
    const start = match.index ?? 0
    if (text.slice(last, start).trim() !== '') parts.push(placeholder)
    parts.push(match[0])
    last = start + match[0].length
  }
  if (parts.length === 0 || text.slice(last).trim() !== '') parts.push(placeholder)
  return parts.join(' ')
}

/** Replaces every word of prose under `root`, headings included, and keeps its
 *  elements. With `keep`, what matches it stays where it was among the
 *  replaced words. The text left is at least the minimum. */
function replaceProse(doc: Document, root: Element, keep: RegExp | null = null): void {
  const prose: Text[] = []
  for (const node of nodesOf(doc, root, SHOW_TEXT)) {
    const text = node as Text
    if (text.data.trim() === '' || isUiWording(text)) continue
    if (text.parentElement?.closest(HEADING)) {
      text.data = replaceAround(text.data, PLACEHOLDER_HEADING, keep)
    } else {
      text.data = replaceAround(text.data, PLACEHOLDER_PROSE, keep)
      prose.push(text)
    }
  }
  const short = JOB_TEXT_MIN - readableText(root).length
  if (short <= 0) return
  const sentences = Math.ceil(short / (PLACEHOLDER_PROSE.length + 1))
  const more = Array.from({ length: sentences }, () => PLACEHOLDER_PROSE).join(' ')
  if (prose[0] !== undefined) {
    prose[0].data = `${prose[0].data} ${more}`
  } else {
    const p = doc.createElement('p')
    p.textContent = more
    root.append(p)
  }
}

/**
 * The fixture's cuts for a Job posting page, on a page cleanForPrivacy has
 * cleaned: keeps the posting's element and its ancestors and nothing else of
 * the page, gives it a fresh head, replaces every word of the posting's prose
 * with placeholder text and keeps its headings and containers, names each of
 * `companies` "Acme", every address in text by its host and every Job posting
 * id "posting-id". False, and the page untouched, when it holds no posting.
 */
export function cutToPosting(doc: Document, companies: readonly string[]): boolean {
  const root = postingRoot(doc)
  if (root === null) return false
  cutTo(doc, root, `Job posting at ${FIXTURE_COMPANY}`)
  replaceProse(doc, root)
  scrubPage(doc, companies, true)
  return true
}

/** A function that gives each address one placeholder, numbered in the order
 *  it is first asked about, whatever the address's case. */
function addressPlaceholders(): (address: string) => string {
  const seen = new Map<string, string>()
  return (address) => {
    const key = address.toLowerCase()
    let placeholder = seen.get(key)
    if (placeholder === undefined) {
      placeholder = `address-${seen.size + 1}@${PLACEHOLDER_ADDRESS_DOMAIN}`
      seen.set(key, placeholder)
    }
    return placeholder
  }
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** A mailto: link with its recipients as placeholders and its subject cleaned
 *  by `cleanSubject` and encoded again. Every other parameter is dropped. */
function cleanMailto(href: string, place: (address: string) => string, cleanSubject: (subject: string) => string): string {
  const rest = href.replace(MAILTO, '').trim()
  const q = rest.indexOf('?')
  const params = (q === -1 ? '' : rest.slice(q + 1)).split('&').map((pair) => {
    const eq = pair.indexOf('=')
    return eq === -1 ? { name: decode(pair).toLowerCase(), value: '' } : { name: decode(pair.slice(0, eq)).toLowerCase(), value: pair.slice(eq + 1) }
  })
  const recipients = [q === -1 ? rest : rest.slice(0, q), ...params.filter((p) => p.name === 'to').map((p) => p.value)]
    .flatMap((part) => decode(part).split(','))
    .flatMap((part) => Array.from(part.matchAll(ADDRESS), (match) => place(match[0])))
  const subject = params.find((p) => p.name === 'subject')
  const query = subject === undefined ? '' : `?subject=${encodeURIComponent(cleanSubject(decode(subject.value)))}`
  return `mailto:${recipients.join(',')}${query}`
}

/** Every text node under `root` that holds an address. */
function addressTexts(doc: Document, root: Node): Text[] {
  const one = new RegExp(ADDRESS.source)
  return nodesOf(doc, root, SHOW_TEXT).filter((node) => one.test((node as Text).data)) as Text[]
}

/** Drops every node under the body that is neither one of `roots`, inside one,
 *  nor an ancestor of one. */
function keepOnly(doc: Document, roots: readonly Node[]): void {
  const prune = (parent: Node): void => {
    for (const child of Array.from(parent.childNodes)) {
      if (roots.some((root) => root.contains(child))) continue
      if (roots.some((root) => child.contains(root))) prune(child)
      else child.remove()
    }
  }
  prune(doc.body)
}

/**
 * The fixture's cuts for a page that applies by email, on a page
 * cleanForPrivacy has cleaned with `keepMailto`: keeps the Job posting, every
 * mailto: link and every address in text, with their ancestors, and nothing
 * else of the page, and gives it a fresh head. Each address, in a link, an
 * attribute or text, becomes `address-<n>@example.org`, numbered in page
 * order, one per address whatever its case. A mailto: link keeps its
 * recipients and its subject; the subject is decoded, cleaned like the page's
 * text and then by `cleanText`, and encoded again. The posting's prose is
 * replaced around the addresses it holds, and each of `companies` is named
 * "Acme". False, and the page untouched, when it holds no mailto: link and no
 * address in text.
 */
export function cutToEmail(doc: Document, companies: readonly string[], cleanText: (text: string) => string = (text) => text): boolean {
  const links = Array.from(doc.body.querySelectorAll('[href]')).filter((el) => MAILTO.test(el.getAttribute('href') ?? ''))
  const texts = addressTexts(doc, doc.body)
  if (links.length === 0 && texts.length === 0) return false
  const posting = postingRoot(doc)
  const roots: Node[] = [
    ...(posting === null ? [] : [posting]),
    ...links,
    ...texts.map((text) => (text.parentElement === null || text.parentElement === doc.body ? text : text.parentElement)),
  ]
  keepOnly(doc, roots)
  freshHead(doc, `Apply by email at ${FIXTURE_COMPANY}`)
  // The root keeps its language and direction and nothing else: a site
  // builder's ids there name the real site.
  const root = doc.documentElement
  for (const { name } of Array.from(root.attributes)) if (name !== 'lang' && name !== 'dir') root.removeAttribute(name)

  const place = addressPlaceholders()
  const swap = (text: string): string => text.replace(ADDRESS, place)
  const cleanSubject = (subject: string): string => cleanText(scrubText(swap(subject), companies, true))
  for (const node of [doc.body, ...nodesOf(doc, doc.body, SHOW_ELEMENT | SHOW_TEXT)]) {
    if (node.nodeType === node.TEXT_NODE) {
      const text = node as Text
      const clean = swap(text.data)
      if (clean !== text.data) text.data = clean
      continue
    }
    const el = node as Element
    for (const { name, value } of Array.from(el.attributes)) {
      const clean = name === 'href' && MAILTO.test(value) ? cleanMailto(value, place, cleanSubject) : swap(value)
      if (clean !== value) el.setAttribute(name, clean)
    }
  }

  if (posting !== null && posting.isConnected) replaceProse(doc, posting, ADDRESS)
  scrubPage(doc, companies, true)
  return true
}
