import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanForPrivacy } from '@jff/shared'
import { saveCapture } from '../host/src/capture.ts'
import { fixtureFrom, PLACEHOLDER_PROSE, sanitizeCapture } from './sanitize-capture.mjs'

// The fixture command given a Capture file (spec #41, testing decision 5).
// Every offending sample is assembled at run time, so this file never holds a
// string the guard it tests would refuse to commit.
const web = ['https', ''].join(':') + '//'
const homePath = ['', 'Users', 'janedoe', 'notes.md'].join('/')
const boardUrl = `${web}job-boards.greenhouse.io/initech/jobs/4012345`

const SCRIPT = fileURLToPath(new URL('./sanitize-capture.mjs', import.meta.url))

/** A raw application page, as the browser's "Save page" writes it mid-application. */
const rawPage = (title = 'Job Application for Staff Engineer at Initech') => `<!doctype html><html lang="en"><head>
  <title>${title}</title>
  <meta property="og:url" content="${boardUrl}">
  <link rel="stylesheet" href="${web}cdn.example.org/app.css">
  <script>window.board = 'initech'</script>
</head><body class="page">
  <header><nav><a href="/initech">Initech careers</a></nav></header>
  <main class="main">
    <div class="job__description"><h1>Staff Engineer</h1><p>Initech builds TPS reports for the whole world.</p></div>
    <form id="application-form" action="/initech/jobs/4012345" method="post">
      <!-- rendered for board initech -->
      <div class="job-description"><p>The role at Initech: long posting prose that must not survive.</p></div>
      <label for="first_name">First Name*</label>
      <input id="first_name" name="first_name" type="text" value="Ada" required>
      <label for="why">Why do you want to join Initech?</label>
      <textarea id="why" name="why">Because of the engines.</textarea>
      <label><input type="checkbox" name="agree" value="yes" checked>I agree</label>
      <select name="country" aria-label="Country"><option>Brazil</option><option selected>Canada</option></select>
      <button type="submit">Submit application</button>
    </form>
  </main>
  <footer><p>Initech, 1 Main Street</p></footer>
</body></html>`

/** The cleaned page the page script hands back for a Capture: the privacy step
 *  on a copy of the document, serialised the way capturePage serialises it. */
function capturedHtml(raw) {
  const doc = new JSDOM(raw).window.document
  cleanForPrivacy(doc)
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}

/** The params the Side panel sends with `capture.save` for that page. */
const saveParams = (raw, url = boardUrl) => ({
  page: { html: capturedHtml(raw), cut: false },
  ats: 'greenhouse',
  url,
  fields: [],
  resolutions: [],
  election: null,
  frameReports: [],
})

/** A Capture file as the Native host would write one, built by hand: for a
 *  Capture the door would refuse today, or one an older build saved. */
const captureJson = (html, url = boardUrl) =>
  `${JSON.stringify({ capture: 1, savedAt: '2026-11-16T12:00:00.000Z', ats: 'greenhouse', url, fields: [], resolutions: [], election: null, frameReports: [], page: { html, cut: false } }, null, 2)}\n`

describe('the privacy step on an already cleaned page', () => {
  it('changes nothing', () => {
    const once = capturedHtml(rawPage())
    expect(capturedHtml(once)).toBe(once)
  })
})

describe('fixtureFrom given a Capture', () => {
  it('makes the same fixture as the raw page it was saved from', () => {
    const fromCapture = fixtureFrom(captureJson(capturedHtml(rawPage())))
    expect(fromCapture).toBe(sanitizeCapture(rawPage()))
    expect(fromCapture).not.toMatch(/initech/i)
    expect(fromCapture).toContain('Why do you want to join Acme?')
    expect(fromCapture).toContain(PLACEHOLDER_PROSE)
  })

  it("reads the Company from the Capture's address when the page's title does not name it", () => {
    const fromCapture = fixtureFrom(captureJson(capturedHtml(rawPage('Apply'))))
    expect(fromCapture).toBe(sanitizeCapture(rawPage('Apply')))
    expect(fromCapture).not.toMatch(/initech/i)
  })

  it('runs the privacy step again, on a page an older build left a Value in', () => {
    const html = '<!DOCTYPE html>\n<html><head><title>Apply</title></head><body><form><label for="a">Name</label><input id="a" name="a" value="Ada"><textarea name="b">typed</textarea></form></body></html>'
    const clean = fixtureFrom(captureJson(html))
    expect(clean).not.toContain('Ada')
    expect(clean).not.toContain('typed')
    expect(clean).toContain('<input id="a" name="a">')
  })

  it('names extra Companies from the caller', () => {
    const html = '<!DOCTYPE html>\n<html><head><title>Apply</title></head><body><form><label for="a">Why Hooli?</label><input id="a"></form></body></html>'
    expect(fixtureFrom(captureJson(html), [], { companies: ['Hooli'] })).toContain('Why Acme?')
  })
})

describe('fixtureFrom given a raw page', () => {
  it('behaves as before', () => {
    expect(fixtureFrom(rawPage())).toBe(sanitizeCapture(rawPage()))
    // A byte-order mark or a blank line first still reads as a page.
    expect(fixtureFrom(`﻿\n${rawPage()}`)).toBe(sanitizeCapture(`﻿\n${rawPage()}`))
  })
})

describe('fixtureFrom given neither a page nor a Capture', () => {
  it.each([
    ['plain text', 'notes about a page I saw'],
    ['JSON that is not a Capture', JSON.stringify({ hello: 'world' })],
    ['a Capture with no page', JSON.stringify({ capture: 1, url: boardUrl })],
    ['broken JSON', '{ "capture": 1, "page": '],
    ['an empty file', ''],
  ])('refuses %s', (_, text) => {
    expect(() => fixtureFrom(text)).toThrow(/neither a page nor a Capture/)
  })
})

describe('the fixture command given a Capture file', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jff-capture-fixture-'))
    writeFileSync(join(dir, 'denylist.txt'), 'springfield heights\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, JFF_PRIVATE_STRINGS: join(dir, 'denylist.txt') },
    })

  it('writes the same fixture as when it is given the raw page', () => {
    const saved = saveCapture(saveParams(rawPage()), { capturesDir: join(dir, 'captures'), privateStringsPath: join(dir, 'denylist.txt') })
    expect(saved.ok).toBe(true)
    writeFileSync(join(dir, 'raw.html'), rawPage())

    const fromRaw = run(join(dir, 'raw.html'), join(dir, 'from-raw.html'))
    const fromCapture = run(saved.path, join(dir, 'from-capture.html'))
    expect(fromRaw.status).toBe(0)
    expect(fromCapture.status).toBe(0)
    expect(readFileSync(join(dir, 'from-capture.html'), 'utf8')).toBe(readFileSync(join(dir, 'from-raw.html'), 'utf8'))
  })

  it('refuses a Capture whose page still holds a private string, and writes nothing', () => {
    const html = `<!DOCTYPE html>\n<html><head><title>Apply</title></head><body><form><label for="a">See ${homePath}</label><input id="a"></form></body></html>`
    writeFileSync(join(dir, 'capture.json'), captureJson(html))
    const result = run(join(dir, 'capture.json'), join(dir, 'out.html'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('home-path')
    expect(existsSync(join(dir, 'out.html'))).toBe(false)
  })

  it('refuses a file that is neither a page nor a Capture, and writes nothing', () => {
    writeFileSync(join(dir, 'notes.json'), JSON.stringify({ hello: 'world' }))
    const result = run(join(dir, 'notes.json'), join(dir, 'out.html'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('neither a page nor a Capture')
    expect(existsSync(join(dir, 'out.html'))).toBe(false)
  })
})
