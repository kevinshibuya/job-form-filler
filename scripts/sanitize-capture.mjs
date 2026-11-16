#!/usr/bin/env node
// Turns a saved application page into a fixture that is safe to commit. A page
// captured mid-application holds whatever was typed into it, and a page captured
// from a real site holds the employer's text, its board's addresses and that
// site's contact addresses and browser keys.
//
//   node scripts/sanitize-capture.mjs [--posting] [--company <name>]... <captured.html|capture.json> <fixture.html>
//
// It takes either a raw page file or a Capture, the JSON file "Save a capture"
// writes: from a Capture it takes the cleaned page and the tab's address, and
// makes the same fixture as from that page's raw file. Anything else it refuses.
// It runs the shared cleaning code the page script runs (shared/src/cleanPage.ts):
// the privacy step drops scripts, styles, images, icons and comments, empties
// every form control and every attribute that carries an address. Then the
// fixture step keeps the application form and the form's ancestors and nothing
// else of the page, replaces the Job posting's prose with placeholder text and
// names the Company "Acme". With `--posting` the page is a Job posting page and
// holds no form: the fixture step keeps the posting's element and its ancestors
// instead, replaces every word of its prose, headings included, with placeholder
// text at least as long as the tool's minimum for Job posting text, and names
// Job posting ids "posting-id". Last, the shared private-strings rules replace
// denylist strings, addresses on real domains and credential-shaped strings, and
// it refuses to write a fixture the guard would still reject. The Company is
// read from the page's title and its board address, as the list of ATSes says
// each ATS writes them; `--company` adds a name the page spells some other way.
// It needs the shared package built (`npm run build -w @jff/shared`). This is a
// CLI: printing is fine.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { cleanForPrivacy, companyNames, cutToFixture, cutToPosting } from '@jff/shared'
import { redactPrivate, scanLine } from '../shared/src/privateStrings.mjs'
import { loadDenylist } from './check-private.mjs'

export { FIXTURE_COMPANY as COMPANY, PLACEHOLDER_PROSE, companyNames } from '@jff/shared'

/**
 * The page's application form, with no typed answer, no employer's prose or
 * name, no address and no key left in it. `companies` adds names of the Company
 * the page does not give away in its title or board address. With `posting`,
 * the page's Job posting instead of its form, with none of its prose left.
 */
export function sanitizeCapture(html, denylist = [], { companies: extra = [], addresses = [], posting = false } = {}) {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  // Read before cleaning: the privacy step drops the head's meta and links.
  const companies = companyNames(doc, extra, addresses)
  // On a Capture's page this runs a second time, which changes nothing.
  cleanForPrivacy(doc)
  if (posting) {
    if (!cutToPosting(doc, companies)) throw new Error('sanitize-capture: the page holds no Job posting')
  } else if (!cutToFixture(doc, companies)) {
    throw new Error('sanitize-capture: the page holds no form and no Control')
  }
  return redactPrivate(dom.serialize(), denylist)
}

const NEITHER = 'sanitize-capture: the file is neither a page nor a Capture: a page is HTML, a Capture is the JSON "Save a capture" writes'

/**
 * What a file given to the command holds: a raw page, or a Capture's cleaned
 * page and the tab's address. Throws on anything else. A page starts with a
 * tag, a doctype or a comment; a Capture is a JSON object marked `capture: 1`
 * whose page has its HTML.
 */
export function readSource(text) {
  const body = text.replace(/^\uFEFF/, '').trimStart()
  if (body.startsWith('<')) return { kind: 'page', html: text, addresses: [], cut: false }
  if (!body.startsWith('{')) throw new Error(NEITHER)
  let capture
  try {
    capture = JSON.parse(body)
  } catch {
    throw new Error(NEITHER)
  }
  if (capture?.capture !== 1 || typeof capture.page?.html !== 'string') throw new Error(NEITHER)
  const addresses = typeof capture.url === 'string' ? [capture.url] : []
  return { kind: 'capture', html: capture.page.html, addresses, cut: capture.page.cut === true }
}

/** The fixture made from a raw page file's text or a Capture file's text. */
export function fixtureFrom(text, denylist = [], { companies = [], posting = false } = {}) {
  const { html, addresses } = readSource(text)
  return sanitizeCapture(html, denylist, { companies, addresses, posting })
}

function parseArgs(argv) {
  const companies = []
  const files = []
  let posting = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--company') companies.push(argv[++i] ?? '')
    else if (argv[i] === '--posting') posting = true
    else files.push(argv[i])
  }
  return { companies, files, posting }
}

function main(argv) {
  const { companies, posting, files: [source, target] } = parseArgs(argv)
  if (!source || !target || companies.includes('')) {
    console.error('usage: sanitize-capture.mjs [--posting] [--company <name>]... <captured.html|capture.json> <fixture.html>')
    return 2
  }
  const denylist = loadDenylist()
  if (denylist === null) {
    console.error('sanitize-capture: no private denylist found, so it cannot know what is yours. Refusing.')
    return 1
  }
  let clean
  try {
    const text = readFileSync(source, 'utf8')
    if (readSource(text).cut) console.error('sanitize-capture: this Capture\'s page was cut at its size limit; the form may be missing its end.')
    clean = fixtureFrom(text, denylist, { companies, posting })
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}. Nothing written.`)
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
