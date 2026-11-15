#!/usr/bin/env node
// Turns a saved application page into a fixture that is safe to commit. A page
// captured mid-application holds whatever was typed into it, and a page captured
// from a real site holds that site's contact addresses and browser keys.
//
//   node scripts/sanitize-capture.mjs <captured.html> <fixture.html>
//
// It empties every form control, then replaces denylist strings, addresses on
// real domains and credential-shaped strings. It refuses to write a fixture the
// guard would still reject. This is a CLI: printing is fine.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { ALLOWED_LITERALS, EMAIL, SECRET, emailAllowed, loadDenylist, scanLine } from './check-private.mjs'

const VALUELESS_INPUTS = new Set(['submit', 'button', 'reset', 'image'])

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The page with no typed answer, no real address and no key left in it. */
export function sanitizeCapture(html, denylist = []) {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  for (const input of doc.querySelectorAll('input')) {
    const type = (input.getAttribute('type') ?? 'text').toLowerCase()
    input.removeAttribute('checked')
    // A hidden input keeps its name but not its value: that is where session
    // and CSRF tokens travel.
    if (!VALUELESS_INPUTS.has(type) && type !== 'checkbox' && type !== 'radio') input.removeAttribute('value')
  }
  for (const area of doc.querySelectorAll('textarea')) area.textContent = ''
  for (const option of doc.querySelectorAll('option[selected]')) option.removeAttribute('selected')

  let out = dom.serialize()
  for (const entry of denylist) out = out.replace(new RegExp(escapeRegExp(entry), 'gi'), 'redacted')
  out = out.replace(EMAIL, (address) => (emailAllowed(address) ? address : 'someone@example.com'))
  out = out.replace(SECRET, (key) => (ALLOWED_LITERALS.has(key) ? key : 'REDACTED-KEY'))
  return out
}

function main([source, target]) {
  if (!source || !target) {
    console.error('usage: sanitize-capture.mjs <captured.html> <fixture.html>')
    return 2
  }
  const denylist = loadDenylist()
  if (denylist === null) {
    console.error('sanitize-capture: no private denylist found, so it cannot know what is yours. Refusing.')
    return 1
  }
  const clean = sanitizeCapture(readFileSync(source, 'utf8'), denylist)
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
