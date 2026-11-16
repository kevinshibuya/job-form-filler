import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanLine } from './check-private.mjs'
import { PLACEHOLDER_PROSE, sanitizeCapture } from './sanitize-capture.mjs'

// Every offending sample is assembled at run time, so this file never holds a
// string the guard it tests would refuse to commit.
const realEmail = ['jane.doe', 'realcorp.io'].join('@')
const token = `ghp_${'a1B2'.repeat(6)}`
const web = ['https', ''].join(':') + '//'
const homePath = ['', 'Users', 'janedoe', 'notes.md'].join('/')

const SCRIPT = fileURLToPath(new URL('./sanitize-capture.mjs', import.meta.url))

function parse(html) {
  return new JSDOM(html).window.document
}

/** A hosted application page: chrome around the posting and the form. */
const hostedPage = `<!doctype html><html lang="en"><head>
  <title>Job Application for Staff Engineer at Initech</title>
  <meta property="og:url" content="${web}job-boards.example.org/initech/jobs/4012345">
  <link rel="stylesheet" href="${web}cdn.example.org/app.css">
  <style>.x { color: red }</style>
  <script>window.board = 'initech'</script>
</head><body class="page">
  <header><nav><a href="/initech">Initech careers</a></nav></header>
  <main class="main">
    <div class="job-post-container">
      <div class="job__description"><h1>Staff Engineer</h1><p>Initech builds TPS reports for the whole world.</p></div>
      <div class="application--container" data-board="/initech/jobs/4012345">
        <h2>Apply for this job</h2>
        <!-- rendered for board initech -->
        <form id="application-form" class="application--form" action="/initech/jobs/4012345" method="post">
          <h3 class="section-header">About Initech</h3>
          <div class="job-description"><p>The role at Initech: long posting prose that must not survive.</p></div>
          <label for="first_name">First Name*</label>
          <input id="first_name" name="first_name" type="text" required aria-required="true" class="input">
          <label for="why">Why do you want to join Initech?</label>
          <textarea id="why" name="why" aria-describedby="why-help"></textarea>
          <p id="why-help">Tell the initech team in a few lines.</p>
          <p class="thanks">Thank you! www.initechjobs.com</p>
          <label for="li">LinkedIn</label>
          <input id="li" name="li" type="text" placeholder="${web}www.linkedin.com/in/your-name" data-url="${web}initech.example.org/x">
          <div role="group" aria-labelledby="src-q">
            <span id="src-q">How did you hear about us?</span>
            <label><input type="checkbox" name="src" value="Initech Ads">Initech Ads</label>
            <label><input type="checkbox" name="src" value="LinkedIn">LinkedIn</label>
          </div>
          <select name="country" aria-label="Country"><option>Brazil</option><option>Canada</option></select>
          <img src="/logo.png" alt="Initech logo">
          <svg class="icon"><path d="M0 0"></path></svg>
          <picture><source srcset="/a.webp 1x, /b.webp 2x"></picture>
          <iframe src="${web}www.example.org/recaptcha"></iframe>
          <a href="${web}initech.example.org/privacy" data-path="/initech/jobs/4012345">Privacy policy</a>
          <script>track('initech')</script>
          <button type="submit">Submit application</button>
        </form>
      </div>
    </div>
  </main>
  <footer><p>Initech, 1 Main Street</p></footer>
</body></html>`

describe('sanitizeCapture cuts the page down to the form', () => {
  const clean = sanitizeCapture(hostedPage)
  const doc = parse(clean)
  const form = doc.querySelector('form')

  it('keeps the form and its ancestors, and no other element', () => {
    expect(form).not.toBeNull()
    const outside = [...doc.body.querySelectorAll('*')].filter((el) => !form.contains(el) && !el.contains(form))
    expect(outside.map((el) => el.tagName)).toEqual([])
    expect(doc.querySelector('header, footer, nav, h2, .job__description')).toBeNull()
    expect(form.closest('.application--container')).not.toBeNull()
    expect(form.closest('main.main')).not.toBeNull()
  })

  it('replaces the Job posting prose with placeholder text', () => {
    expect(clean).not.toContain('TPS reports')
    expect(clean).not.toContain('long posting prose')
    expect(form.querySelector('.job-description').textContent.trim()).toBe(PLACEHOLDER_PROSE)
  })

  it('rewrites the page title and names the Company "Acme" everywhere', () => {
    expect(clean).not.toMatch(/initech/i)
    expect(doc.title).toContain('Acme')
    expect(doc.title).not.toContain('Staff Engineer')
    expect(form.querySelector('h3').textContent).toBe('About Acme')
    expect(form.querySelector('label[for="why"]').textContent).toBe('Why do you want to join Acme?')
    expect(doc.getElementById('why-help').textContent).toBe('Tell the Acme team in a few lines.')
    expect(form.querySelector('input[value="Acme Ads"]')).not.toBeNull()
    expect(form.querySelector('.thanks').textContent).toBe('Thank you! example.com')
  })

  it('empties every attribute that carries an address, and keeps no absolute URL, board path or posting id', () => {
    expect(form.getAttribute('action')).toBe('')
    expect(form.querySelector('a').getAttribute('href')).toBe('')
    expect(form.querySelector('a').getAttribute('data-path')).toBe('')
    expect(doc.getElementById('li').getAttribute('data-url')).toBe('')
    expect(doc.querySelector('.application--container').getAttribute('data-board')).toBe('')
    expect(clean).not.toMatch(/https?:\/\//)
    expect(clean).not.toMatch(/\/jobs\/\d/)
    expect(clean).not.toContain('4012345')
  })

  it('drops scripts, styles, inline images, icons, frames and comments', () => {
    expect(doc.querySelector('script, style, link, img, svg, picture, source, iframe')).toBeNull()
    expect(clean).not.toContain('<!--')
    expect(clean).not.toContain('track(')
  })

  it('keeps the labels, Options, headings and the attributes Enumeration reads', () => {
    const first = doc.getElementById('first_name')
    expect(first.getAttribute('name')).toBe('first_name')
    expect(first.getAttribute('type')).toBe('text')
    expect(first.hasAttribute('required')).toBe(true)
    expect(first.getAttribute('aria-required')).toBe('true')
    expect(first.getAttribute('class')).toBe('input')
    expect(doc.getElementById('why').getAttribute('aria-describedby')).toBe('why-help')
    expect(form.querySelector('[role="group"]').getAttribute('aria-labelledby')).toBe('src-q')
    expect([...form.querySelectorAll('input[name="src"]')].map((box) => box.parentElement.textContent)).toEqual(['Acme Ads', 'LinkedIn'])
    expect([...form.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Brazil', 'Canada'])
    expect(form.querySelector('select').getAttribute('aria-label')).toBe('Country')
    expect(form.querySelector('button').textContent).toBe('Submit application')
    expect(doc.getElementById('li').getAttribute('placeholder')).toBe('www.linkedin.com')
  })
})

describe('sanitizeCapture on a page with no form element', () => {
  const page = `<!doctype html><html><head><title>Product Engineer @ Initech</title></head><body>
    <div id="root"><div class="split">
      <div class="left"><h1>Product Engineer</h1><p>At Initech we build calm software.</p></div>
      <div class="right"><div id="form">
        <div class="autofill"><input type="file" aria-label="Autofill from resume"></div>
        <div class="entries">
          <label for="name">Name</label><input id="name" name="_systemfield_name">
          <label for="built">What did you build?</label><textarea id="built" name="built"></textarea>
        </div>
      </div></div>
    </div></div>
    <div class="grecaptcha-badge"><textarea name="g-recaptcha-response" style="display: none;"></textarea></div>
  </body></html>`

  it('keeps the smallest element that holds all of its Controls', () => {
    const doc = parse(sanitizeCapture(page))
    const kept = doc.getElementById('form')
    expect(kept).not.toBeNull()
    expect(kept.querySelectorAll('input, textarea')).toHaveLength(3)
    expect(doc.querySelector('.left, .grecaptcha-badge')).toBeNull()
    const outside = [...doc.body.querySelectorAll('*')].filter((el) => !kept.contains(el) && !el.contains(kept))
    expect(outside.map((el) => el.tagName)).toEqual([])
    expect(doc.title).toContain('Acme')
    expect(doc.documentElement.outerHTML).not.toMatch(/initech/i)
  })

  // #53: a listing page's locale switcher is a button drawn as a combobox, with
  // no Option in the page until it opens. Enumeration counts it as a Field, so
  // the fixture command counts it as a Control.
  const listing = `<!doctype html><html><head><title>Initech Careers | Product Engineer</title></head><body>
    <main><h1>Product Engineer</h1><p>At Initech we build calm software.</p><a class="apply">Apply</a></main>
    <footer><div class="links"><a>Support</a></div>
      <div class="bottom"><div class="locale"><button type="button" class="locale-switcher" aria-label="English. Choose your language" aria-haspopup="listbox" aria-expanded="false" role="combobox"><span>English</span></button></div></div>
      <button type="button" class="cookie">Accept all</button>
    </footer>
  </body></html>`

  it('keeps a lone button drawn as a combobox, and only it, when the page holds no other Control', () => {
    const doc = parse(sanitizeCapture(listing, [], { companies: ['Initech'] }))
    const combo = doc.querySelector('[role="combobox"]')
    expect(combo).not.toBeNull()
    expect(combo.textContent).toBe('English')
    expect(doc.querySelector('main, .links, .cookie')).toBeNull()
    expect(doc.documentElement.outerHTML).not.toMatch(/initech/i)
  })
})

describe('sanitizeCapture finds the Company', () => {
  const pageTitled = (title, extra = '') => `<!doctype html><html><head><title>${title}</title>${extra}</head><body>
    <form><label for="q">Why Initech, and why Hooli?</label><input id="q" name="q"></form></body></html>`

  it('reads it from a Lever title, a legal suffix and a board slug', () => {
    const lever = sanitizeCapture(pageTitled('Initech - Senior Engineer'))
    expect(lever).toContain('Why Acme, and why Hooli?')
    const suffixed = sanitizeCapture(pageTitled('Job Application for Engineer at Initech, Inc.'))
    expect(suffixed).toContain('Why Acme, and why Hooli?')
    const slugOnly = sanitizeCapture(pageTitled('Apply', `<meta property="og:url" content="${web}jobs.lever.co/initech/abc">`))
    expect(slugOnly).toContain('Why Acme, and why Hooli?')
  })

  it('reads it the way the list of ATSes says Greenhouse, Ashby and Lever write it', () => {
    const ashbyTitle = sanitizeCapture(pageTitled('Senior Engineer @ Initech'))
    expect(ashbyTitle).toContain('Why Acme, and why Hooli?')
    const ashbySlug = sanitizeCapture(pageTitled('Apply', `<link rel="canonical" href="${web}jobs.ashbyhq.com/initech/123">`))
    expect(ashbySlug).toContain('Why Acme, and why Hooli?')
    const greenhouseSlug = sanitizeCapture(pageTitled('Apply', `<meta property="og:url" content="${web}boards.greenhouse.io/initech/jobs/1">`))
    expect(greenhouseSlug).toContain('Why Acme, and why Hooli?')
    const embedded = sanitizeCapture(pageTitled('Apply', `<meta property="og:url" content="${web}boards.greenhouse.io/embed/job_app?for=initech">`))
    expect(embedded).toContain('Why Acme, and why Hooli?')
    const ownBoard = sanitizeCapture(pageTitled('Apply', `<meta property="og:url" content="/initech/jobs/42">`))
    expect(ownBoard).toContain('Why Acme, and why Hooli?')
  })

  it('takes extra names from the caller', () => {
    const clean = sanitizeCapture(pageTitled('Initech - Engineer'), [], { companies: ['Hooli'] })
    expect(clean).toContain('Why Acme, and why Acme?')
  })
})

describe('sanitizeCapture still strips what it stripped before', () => {
  const page = `<!doctype html><html><body><form>
    <input type="text" name="name" value="Jane Doe">
    <input type="hidden" name="csrf" value="tok-123">
    <input type="checkbox" name="agree" value="yes" checked>
    <input type="submit" value="Apply">
    <textarea name="why">I live in Springfield Heights</textarea>
    <select name="c"><option>One</option><option selected>Two</option></select>
    <p>Questions? ${realEmail} or ada@example.com</p>
    <p data-key="${token}">Key</p>
    <script>window.cfg = { key: "${token}" }</script>
  </form></body></html>`

  const clean = sanitizeCapture(page, ['jane doe', 'springfield heights'])

  it('empties typed answers, hidden values and selections', () => {
    expect(clean).not.toContain('Jane Doe')
    expect(clean).not.toContain('tok-123')
    expect(clean).not.toContain('Springfield Heights')
    expect(clean).not.toMatch(/checked|selected/)
  })

  it('keeps the structure a scan reads', () => {
    expect(clean).toContain('<input type="text" name="name">')
    expect(clean).toContain('<input type="checkbox" name="agree" value="yes">')
    expect(clean).toContain('<input type="submit" value="Apply">')
    expect(clean).toContain('<option>Two</option>')
  })

  it('replaces real addresses and keys, and leaves the persona alone', () => {
    expect(clean).not.toContain(realEmail)
    expect(clean).not.toContain(token)
    expect(clean).toContain('someone@example.com or ada@example.com')
    expect(clean).toContain('REDACTED-KEY')
  })

  it('leaves nothing the guard would refuse', () => {
    const left = clean.split('\n').flatMap((line) => scanLine(line, ['jane doe', 'springfield heights']))
    expect(left).toEqual([])
  })
})

describe('the sanitize-capture CLI', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jff-sanitize-'))
    writeFileSync(join(dir, 'denylist.txt'), 'springfield heights\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, JFF_PRIVATE_STRINGS: join(dir, 'denylist.txt') },
    })

  it('writes the cut fixture, naming extra Companies from --company', () => {
    writeFileSync(join(dir, 'in.html'), '<html><head><title>Apply</title></head><body><form><label for="a">Why Initech?</label><input id="a"></form></body></html>')
    const result = run('--company', 'Initech', join(dir, 'in.html'), join(dir, 'out.html'))
    expect(result.status).toBe(0)
    expect(readFileSync(join(dir, 'out.html'), 'utf8')).toContain('Why Acme?')
  })

  it('refuses to write what the personal-data guard would refuse', () => {
    writeFileSync(join(dir, 'in.html'), `<html><body><form><label for="a">See ${homePath}</label><input id="a"></form></body></html>`)
    const result = run(join(dir, 'in.html'), join(dir, 'out.html'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('home-path')
    expect(existsSync(join(dir, 'out.html'))).toBe(false)
  })
})
