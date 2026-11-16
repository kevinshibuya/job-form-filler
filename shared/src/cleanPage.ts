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
 *
 * Private strings, real e-mail addresses and credentials are replaced on the
 * serialised page by privateStrings.mjs, which every caller shares.
 */

import { ATS_LIST, companyFromTitle, companySlugFrom } from './ats.js'

export const FIXTURE_COMPANY = 'Acme'
export const PLACEHOLDER_PROSE = 'Placeholder text where the Job posting described the role.'

const SHOW_COMMENT = 0x80
const SHOW_TEXT = 0x4

const VALUELESS_INPUTS = new Set(['submit', 'button', 'reset', 'image'])
const NOT_CONTROLS = new Set(['hidden', 'submit', 'button', 'reset', 'image'])
const CONTROL = 'input, select, textarea'

/** Elements that carry no question: code, styling, pictures, icons, embeds. */
const DROPPED = 'script, style, link, meta, base, noscript, template, img, svg, picture, source, iframe, object, embed, canvas, video, audio'

/** Attributes whose whole value is an address. */
const ADDRESS_ATTRS = new Set(['action', 'href', 'src', 'srcset', 'formaction', 'poster', 'xlink:href', 'background', 'cite', 'data', 'ping', 'longdesc', 'codebase', 'manifest'])
const ADDRESS_VALUE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/|\.\.?\/)|:\/\//i
const URL_IN_TEXT = /(?:https?:)?\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})[^\s"'<>)]*/gi
const BOARD_PATH = /\/jobs\/\d+/gi
const HOST = /(?<![\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?![\w-])/gi

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
 *  attribute that holds an address. Every other element stays where it was. */
export function cleanForPrivacy(doc: Document): void {
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
function cutTo(doc: Document, root: Element): void {
  for (let keep: Element = root; keep !== doc.documentElement; ) {
    const parent: Element | null = keep.parentElement
    if (parent === null) break
    for (const sibling of Array.from(parent.childNodes)) if (sibling !== keep) sibling.remove()
    keep = parent
  }
  const head = doc.createElement('head')
  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  const title = doc.createElement('title')
  title.textContent = `Application form at ${FIXTURE_COMPANY}`
  head.append(charset, title)
  doc.documentElement.insertBefore(head, doc.body)
}

function scrubText(text: string, companies: readonly string[]): string {
  let out = text.replace(URL_IN_TEXT, (_, host: string) => host).replace(BOARD_PATH, '/jobs')
  // A host that spells the Company inside a longer word (its careers site, its
  // mail domain) is the Company too.
  out = out.replace(HOST, (host) => (companies.some((name) => host.toLowerCase().includes(name.toLowerCase())) ? 'example.com' : host))
  for (const name of companies) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'), FIXTURE_COMPANY)
  }
  return out
}

function scrubAttributes(el: Element, companies: readonly string[]): void {
  for (const { name, value } of Array.from(el.attributes)) {
    const clean = scrubText(value, companies)
    if (clean !== value) el.setAttribute(name, clean)
  }
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
  cutTo(doc, root)

  for (const prose of Array.from(root.querySelectorAll(POSTING_PROSE))) {
    if (!prose.isConnected || prose.querySelector(CONTROL) !== null) continue
    const p = doc.createElement('p')
    p.textContent = PLACEHOLDER_PROSE
    prose.replaceChildren(p)
  }

  for (const el of Array.from(doc.body.querySelectorAll('*'))) scrubAttributes(el, companies)
  scrubAttributes(doc.body, companies)
  scrubAttributes(doc.documentElement, companies)
  for (const node of nodesOf(doc, doc.body, SHOW_TEXT)) {
    const text = node as Text
    const clean = scrubText(text.data, companies)
    if (clean !== text.data) text.data = clean
  }
  return true
}
