#!/usr/bin/env node
// Turns a saved application page into a fixture that is safe to commit. A page
// captured mid-application holds whatever was typed into it, and a page captured
// from a real site holds the employer's text, its board's addresses and that
// site's contact addresses and browser keys.
//
//   node scripts/sanitize-capture.mjs [--company <name>]... <captured.html> <fixture.html>
//
// It keeps the application form and the form's ancestors and nothing else of the
// page, replaces the Job posting's prose with placeholder text, names the Company
// "Acme", empties every attribute that carries an address and drops scripts,
// styles, images and icons. Then it empties every form control and replaces
// denylist strings, addresses on real domains and credential-shaped strings. It
// refuses to write a fixture the guard would still reject. The Company is read
// from the page's title and its board address; `--company` adds a name the page
// spells some other way. This is a CLI: printing is fine.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { ALLOWED_LITERALS, EMAIL, SECRET, emailAllowed, loadDenylist, scanLine } from './check-private.mjs'

export const COMPANY = 'Acme'
export const PLACEHOLDER_PROSE = 'Placeholder text where the Job posting described the role.'

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

/** Containers the ATSs put a Job posting's description in. Never one holding a Control. */
const POSTING_PROSE = [
  '[class*="job-description" i]',
  '[id*="job-description" i]',
  '[class*="job__description" i]',
  '[class*="job_description" i]',
  '[class*="posting-description" i]',
  '[data-qa*="job-description" i]',
  '[class*="descricao" i]',
].join(', ')

/** Where a hosted board puts the Company's slug. */
const SLUG_PATTERNS = [
  /greenhouse\.io\/(?:embed\/job_app\?for=)?([a-z0-9_-]+)/i,
  /jobs\.lever\.co\/([a-z0-9_-]+)/i,
  /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i,
  /^\/([a-z0-9_-]+)\/jobs\/\d+/i,
]
const BOARD_WORDS = new Set(['embed', 'jobs', 'boards', 'job-boards', 'api'])
const LEGAL_SUFFIX = /[,\s]+(?:inc\.?|llc|ltd\.?|limited|gmbh|s\.?a\.?|ltda\.?|corp\.?|co\.?)$/i

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The Company's names as this page spells them: title, board slug, and the caller's. */
export function companyNames(doc, extra = []) {
  const names = new Set()
  const add = (name) => {
    const trimmed = (name ?? '').replace(/\s+/g, ' ').trim()
    if (trimmed.length < 2) return
    names.add(trimmed)
    const bare = trimmed.replace(LEGAL_SUFFIX, '').trim()
    if (bare.length >= 2) names.add(bare)
  }
  const title = doc.title.replace(/\s+/g, ' ').trim()
  const fromTitle =
    /^Job Application for .+ at (.+)$/i.exec(title)?.[1] ?? // Greenhouse
    / @ (.+)$/.exec(title)?.[1] ?? // Ashby
    /^(.+?) [-–] /.exec(title)?.[1] // Lever
  add(fromTitle)
  add(doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content'))
  const addresses = [
    doc.querySelector('meta[property="og:url"]')?.getAttribute('content'),
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    ...[...doc.querySelectorAll('form')].map((form) => form.getAttribute('action')),
  ]
  for (const address of addresses) {
    if (!address) continue
    for (const pattern of SLUG_PATTERNS) {
      const slug = pattern.exec(address)?.[1]
      if (slug && !BOARD_WORDS.has(slug.toLowerCase())) add(slug)
    }
  }
  for (const name of extra) add(name)
  return [...names].sort((a, b) => b.length - a.length)
}

function isControl(el) {
  if (el.tagName === 'INPUT' && NOT_CONTROLS.has((el.getAttribute('type') ?? 'text').toLowerCase())) return false
  if (/recaptcha/i.test(el.getAttribute('name') ?? '')) return false
  for (let node = el; node !== null; node = node.parentElement) {
    if (/display\s*:\s*none/i.test(node.getAttribute('style') ?? '')) return false
  }
  return true
}

/** The application form, or the smallest element that holds every Control. */
function formRoot(doc) {
  const controls = [...doc.body.querySelectorAll(CONTROL)].filter(isControl)
  const forms = [...doc.querySelectorAll('form')]
    .map((form) => ({ form, count: controls.filter((c) => form.contains(c)).length }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count)
  if (forms.length > 0) return forms[0].form
  if (controls.length === 0) return null
  let root = controls[0].parentElement
  while (root !== doc.body && !controls.every((c) => root.contains(c))) root = root.parentElement
  return root
}

/** Drops every node that is neither `root`, inside it, nor one of its ancestors. */
function cutTo(doc, root) {
  for (let keep = root; keep !== doc.documentElement; keep = keep.parentElement) {
    for (const sibling of [...keep.parentElement.childNodes]) if (sibling !== keep) sibling.remove()
  }
  const head = doc.createElement('head')
  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  const title = doc.createElement('title')
  title.textContent = `Application form at ${COMPANY}`
  head.append(charset, title)
  doc.documentElement.insertBefore(head, doc.body)
}

function scrubText(text, companies) {
  let out = text.replace(URL_IN_TEXT, (_, host) => host).replace(BOARD_PATH, '/jobs')
  // A host that spells the Company inside a longer word (its careers site, its
  // mail domain) is the Company too.
  out = out.replace(HOST, (host) => (companies.some((name) => host.toLowerCase().includes(name.toLowerCase())) ? 'example.com' : host))
  for (const name of companies) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'), COMPANY)
  }
  return out
}

function scrubAttributes(el, companies) {
  for (const { name, value } of [...el.attributes]) {
    if (ADDRESS_ATTRS.has(name) || (name.startsWith('data-') && ADDRESS_VALUE.test(value))) {
      el.setAttribute(name, '')
    } else if (name === 'style') {
      el.setAttribute(name, scrubText(value.replace(/url\([^)]*\)/gi, 'url()'), companies))
    } else {
      const clean = scrubText(value, companies)
      if (clean !== value) el.setAttribute(name, clean)
    }
  }
}

function emptyControls(doc) {
  for (const input of doc.querySelectorAll('input')) {
    const type = (input.getAttribute('type') ?? 'text').toLowerCase()
    input.removeAttribute('checked')
    // A hidden input keeps its name but not its value: that is where session
    // and CSRF tokens travel.
    if (!VALUELESS_INPUTS.has(type) && type !== 'checkbox' && type !== 'radio') input.removeAttribute('value')
  }
  for (const area of doc.querySelectorAll('textarea')) area.textContent = ''
  for (const option of doc.querySelectorAll('option[selected]')) option.removeAttribute('selected')
}

/**
 * The page's application form, with no typed answer, no employer's prose or
 * name, no address and no key left in it. `companies` adds names of the Company
 * the page does not give away in its title or board address.
 */
export function sanitizeCapture(html, denylist = [], { companies: extra = [] } = {}) {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const companies = companyNames(doc, extra)
  const root = formRoot(doc)
  if (root === null) throw new Error('sanitize-capture: the page holds no form and no Control')

  cutTo(doc, root)
  for (const el of [...doc.body.querySelectorAll(DROPPED)]) el.remove()
  const comments = doc.createTreeWalker(doc.documentElement, dom.window.NodeFilter.SHOW_COMMENT)
  const dead = []
  while (comments.nextNode()) dead.push(comments.currentNode)
  for (const comment of dead) comment.remove()

  for (const prose of [...root.querySelectorAll(POSTING_PROSE)]) {
    if (!prose.isConnected || prose.querySelector(CONTROL) !== null) continue
    const p = doc.createElement('p')
    p.textContent = PLACEHOLDER_PROSE
    prose.replaceChildren(p)
  }

  emptyControls(doc)
  for (const el of doc.body.querySelectorAll('*')) scrubAttributes(el, companies)
  scrubAttributes(doc.body, companies)
  scrubAttributes(doc.documentElement, companies)
  const texts = doc.createTreeWalker(doc.body, dom.window.NodeFilter.SHOW_TEXT)
  while (texts.nextNode()) {
    const node = texts.currentNode
    const clean = scrubText(node.data, companies)
    if (clean !== node.data) node.data = clean
  }

  let out = dom.serialize()
  for (const entry of denylist) out = out.replace(new RegExp(escapeRegExp(entry), 'gi'), 'redacted')
  out = out.replace(EMAIL, (address) => (emailAllowed(address) ? address : 'someone@example.com'))
  out = out.replace(SECRET, (key) => (ALLOWED_LITERALS.has(key) ? key : 'REDACTED-KEY'))
  return out
}

function parseArgs(argv) {
  const companies = []
  const files = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--company') companies.push(argv[++i] ?? '')
    else files.push(argv[i])
  }
  return { companies, files }
}

function main(argv) {
  const { companies, files: [source, target] } = parseArgs(argv)
  if (!source || !target || companies.includes('')) {
    console.error('usage: sanitize-capture.mjs [--company <name>]... <captured.html> <fixture.html>')
    return 2
  }
  const denylist = loadDenylist()
  if (denylist === null) {
    console.error('sanitize-capture: no private denylist found, so it cannot know what is yours. Refusing.')
    return 1
  }
  let clean
  try {
    clean = sanitizeCapture(readFileSync(source, 'utf8'), denylist, { companies })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  const left = clean.split('\n').flatMap((line, index) => scanLine(line, denylist).map((hit) => ({ ...hit, line: index + 1 })))
  if (left.length > 0) {
    console.error(`sanitize-capture: ${left.length} finding(s) survive, nothing written:`)
    for (const { rule, line, detail } of left.slice(0, 20)) console.error(`  ${rule.padEnd(14)} line ${line}  ${detail}`)
    return 1
  }
  writeFileSync(target, clean)
  console.error(`sanitize-capture: wrote ${target}. Read it once before committing: free text you typed nowhere else is yours to spot.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
