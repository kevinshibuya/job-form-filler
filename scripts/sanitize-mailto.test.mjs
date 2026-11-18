import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JOB_TEXT_MIN } from '@jff/shared'
import { scanLine } from './check-private.mjs'
import { PLACEHOLDER_PROSE, sanitizeCapture } from './sanitize-capture.mjs'

// The fixture command's email cut (spec #66, ticket #69): a page that applies
// by email keeps its Job posting, its mailto: links and its addresses, with
// each address replaced whole by a numbered placeholder. Every offending
// sample is assembled at run time, so this file never holds a string the guard
// would refuse to commit.
const at = (local, domain) => [local, domain].join('@')
const applyAddress = at('karriere.team', 'initech.io')
const privacyAddress = at('datenschutz', 'initech.io')
const ccAddress = at('hr.lead', 'initech.io')
const bccAddress = at('archive', 'initech.io')
const web = ['https', ''].join(':') + '//'
const homePath = ['', 'Users', 'janedoe', 'notes.md'].join('/')

const SCRIPT = fileURLToPath(new URL('./sanitize-capture.mjs', import.meta.url))
const PLACEHOLDER_ADDRESS = /^address-\d+@example\.org$/
const ANY_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

function parse(html) {
  return new JSDOM(html).window.document
}

const longProse = 'Initech builds TPS reports for the whole world and needs a backend engineer who keeps them on time. '.repeat(5)

/** A careers page that applies by email: one address in three mailto: links and
 *  once in text, written in two cases, and a second address in the footer. */
const careersPage = `<!doctype html><html lang="de" dir="ltr" data-wf-site="5f2b9c0d1e3a4b6c7d8e9f01" data-wf-page="5f2b9c0d1e3a4b6c7d8e9f02" class="w-mod-js"><head>
  <title>Initech Careers | Backend Engineer</title>
  <meta property="og:site_name" content="Initech">
  <link rel="canonical" href="${web}careers.initech.io/backend">
  <script>window.contact = '${applyAddress}'</script>
</head><body>
  <header class="site-header"><nav><a href="/">Initech home</a></nav>
    <a class="cta" href="mailto:${applyAddress}?subject=Bewerbung%20bei%20Initech&amp;body=Hallo%20Initech&amp;cc=${ccAddress}&amp;bcc=${bccAddress}">Bewerben</a>
  </header>
  <main>
    <article class="job-post">
      <h1>Backend Engineer</h1>
      <p>${longProse}</p>
      <p class="how">Send your CV to ${applyAddress.toUpperCase()} and mention the role, see ${web}initech.io/jobs.</p>
      <p class="link"><a href="MAILTO:${applyAddress}?subject=Bewerbung%20bei%20Initech&amp;cc=${ccAddress}">Jetzt bewerben</a></p>
    </article>
  </main>
  <aside class="related"><h2>Other roles</h2><p>Frontend Engineer at Initech</p></aside>
  <div class="sticky"><a href="mailto:${applyAddress}?subject=Bewerbung%20bei%20Initech">Apply</a></div>
  <form class="newsletter-hidden" hidden></form>
  <footer>
    <p class="privacy">Privacy questions go to ${privacyAddress}.</p>
    <p class="legal">Initech GmbH, 1 Main Street</p>
  </footer>
</body></html>`

describe('sanitizeCapture with the email cut, on a careers page', () => {
  const clean = sanitizeCapture(careersPage, [], { email: true })
  const doc = parse(clean)
  const links = [...doc.querySelectorAll('a')].filter((a) => /^mailto:/i.test(a.getAttribute('href') ?? ''))

  it('keeps every mailto: link as a mailto: link to a placeholder address, with its subject and no body, cc or bcc', () => {
    expect(links).toHaveLength(3)
    for (const a of links) {
      const href = a.getAttribute('href')
      expect(href).toMatch(/^mailto:address-1@example\.org\?subject=/i)
      expect(href).not.toMatch(/body=|cc=|bcc=/i)
    }
  })

  it('cleans the subject like the page\'s text and encodes it again, so the Company is "Acme"', () => {
    for (const a of links) expect(a.getAttribute('href')).toBe('mailto:address-1@example.org?subject=Bewerbung%20bei%20Acme')
  })

  it('gives one address written in two cases one placeholder, and a second address another', () => {
    expect(doc.querySelector('.how').textContent).toContain('address-1@example.org')
    expect(doc.querySelector('.privacy').textContent).toBe('Privacy questions go to address-2@example.org.')
    const addresses = new Set(clean.match(ANY_ADDRESS))
    expect([...addresses].sort()).toEqual(['address-1@example.org', 'address-2@example.org'])
  })

  it('keeps nothing of a real address, its local part included, nor a dropped cc or bcc', () => {
    for (const gone of ['karriere', 'datenschutz', 'hr.lead', 'archive', 'initech']) expect(clean.toLowerCase()).not.toContain(gone)
  })

  it('keeps the posting, the mailto: links and the addresses with their ancestors, and nothing else', () => {
    const roots = [doc.querySelector('.job-post'), doc.querySelector('.cta'), doc.querySelector('.sticky a'), doc.querySelector('.privacy')]
    for (const root of roots) expect(root).not.toBeNull()
    const outside = [...doc.body.querySelectorAll('*')].filter((el) => !roots.some((root) => root.contains(el) || el.contains(root)))
    expect(outside.map((el) => el.tagName)).toEqual([])
    expect(doc.querySelector('nav, aside, form, .legal')).toBeNull()
  })

  it('replaces the posting\'s prose and keeps an address in it where it was', () => {
    expect(clean).not.toContain('TPS reports')
    expect(clean).not.toContain('Send your CV')
    const how = doc.querySelector('.how').textContent
    expect(how).toBe(`${PLACEHOLDER_PROSE} address-1@example.org ${PLACEHOLDER_PROSE}`)
    expect(doc.querySelector('.job-post h1').textContent).not.toContain('Backend')
    expect(doc.querySelector('.job-post').textContent.replace(/\s+/g, ' ').trim().length).toBeGreaterThanOrEqual(JOB_TEXT_MIN)
  })

  it('gives the page a fresh head, names the Company "Acme" and keeps the declared language', () => {
    expect(doc.documentElement.getAttribute('lang')).toBe('de')
    expect([...doc.head.children].map((el) => el.tagName)).toEqual(['META', 'TITLE'])
    expect(doc.title).toContain('Acme')
    expect(doc.querySelector('script, link')).toBeNull()
    expect(clean).not.toMatch(/https?:\/\//)
  })

  it('keeps only the language and direction on the root, so a site builder\'s ids there do not name the site', () => {
    expect([...doc.documentElement.attributes].map((a) => a.name).sort()).toEqual(['dir', 'lang'])
    expect(clean).not.toContain('5f2b9c0d1e3a4b6c7d8e9f0')
  })

  it('leaves nothing the guard would refuse', () => {
    expect(clean.split('\n').flatMap((line) => scanLine(line))).toEqual([])
  })
})

describe('the email cut\'s mailto: rules', () => {
  const page = (body, head = '<title>Initech Careers</title>') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
  const hrefs = (html) => [...parse(html).querySelectorAll('a')].map((a) => a.getAttribute('href'))

  it('keeps one placeholder per recipient of a link with several', () => {
    const two = at('jobs', 'initech.io')
    const clean = sanitizeCapture(page(`<a href="mailto:${applyAddress},${two}?subject=Hi">Mail us</a><p>Or ${two}</p>`), [], { email: true })
    expect(hrefs(clean)).toEqual(['mailto:address-1@example.org,address-2@example.org?subject=Hi'])
    expect(parse(clean).querySelector('p').textContent).toBe('Or address-2@example.org')
  })

  it('numbers placeholders in page order, attributes and text alike', () => {
    const second = at('jobs', 'initech.io')
    const clean = sanitizeCapture(page(`<p data-contact="${second}">Write to ${applyAddress} or ${second}</p>`), [], { email: true })
    const p = parse(clean).querySelector('p')
    expect(p.getAttribute('data-contact')).toBe('address-1@example.org')
    expect(p.textContent).toBe('Write to address-2@example.org or address-1@example.org')
  })

  it('cleans a subject of private strings and addresses, still encoded', () => {
    const subject = encodeURIComponent(`Application from Springfield Heights via ${privacyAddress}`)
    const clean = sanitizeCapture(page(`<a href="mailto:${applyAddress}?subject=${subject}">Apply</a>`), ['springfield heights'], { email: true })
    expect(hrefs(clean)).toEqual([`mailto:address-1@example.org?subject=${encodeURIComponent('Application from redacted via address-2@example.org')}`])
  })

  it('keeps a link with no subject as a bare placeholder recipient', () => {
    const clean = sanitizeCapture(page(`<a href="mailto:${applyAddress}?body=Hello">Apply</a>`), [], { email: true })
    expect(hrefs(clean)).toEqual(['mailto:address-1@example.org'])
  })

  it('placeholders even an address on a test domain, so every address has one form', () => {
    const clean = sanitizeCapture(page('<p>Questions: ada@example.com</p>'), [], { email: true })
    expect(parse(clean).querySelector('p').textContent).toBe('Questions: address-1@example.org')
  })

  it('works on a page with no form, and refuses one with no mailto: link and no address', () => {
    expect(() => sanitizeCapture(page('<main><p>Nothing to send.</p></main>'), [], { email: true })).toThrow(/no mailto: link and no address/)
  })

  it('keeps a language the page declares in a content-language meta only', () => {
    const clean = sanitizeCapture(page(`<p>Write to ${applyAddress}</p>`, '<meta http-equiv="Content-Language" content="nl"><title>x</title>'), [], { email: true })
    expect(parse(clean).documentElement.getAttribute('lang')).toBe('nl')
  })

  it('refuses the email cut and the posting cut together', () => {
    expect(() => sanitizeCapture(page(`<p>${applyAddress}</p>`), [], { email: true, posting: true })).toThrow(/one cut/)
  })

  it('leaves a non-mailto href empty, as the privacy step does', () => {
    const clean = sanitizeCapture(page(`<p>Write to ${applyAddress} <a href="${web}initech.io/jobs">jobs</a></p>`), [], { email: true })
    expect(hrefs(clean)).toEqual([''])
  })
})

describe('the email cut on a job board page', () => {
  const boardPage = `<!doctype html><html lang="pt-BR"><head><title>Initech - Backend Engineer</title></head><body>
    <header><a href="/vagas">All jobs</a></header>
    <main><div class="job-description">
      <h2>Backend Engineer</h2>
      <p>${longProse}</p>
      <p>Interested? Write to ${applyAddress} with your CV.</p>
    </div></main>
    <footer><p>Board footer</p></footer>
  </body></html>`
  const clean = sanitizeCapture(boardPage, [], { email: true })
  const doc = parse(clean)

  it('keeps the address inside the description and no mailto: link', () => {
    expect(clean).not.toContain('mailto:')
    const ps = [...doc.querySelectorAll('.job-description p')].map((p) => p.textContent)
    expect(ps).toContain(`${PLACEHOLDER_PROSE} address-1@example.org ${PLACEHOLDER_PROSE}`)
    expect(new Set(clean.match(ANY_ADDRESS))).toEqual(new Set(['address-1@example.org']))
    expect(doc.querySelector('header, footer')).toBeNull()
    expect(doc.documentElement.getAttribute('lang')).toBe('pt-BR')
  })
})

describe('the sanitize-capture CLI with --email', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jff-sanitize-email-'))
    writeFileSync(join(dir, 'denylist.txt'), 'springfield heights\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, JFF_PRIVATE_STRINGS: join(dir, 'denylist.txt') },
    })

  it('writes the email cut of a page with no form', () => {
    writeFileSync(join(dir, 'in.html'), careersPage)
    const result = run('--email', join(dir, 'in.html'), join(dir, 'out.html'))
    expect(result.status).toBe(0)
    const out = readFileSync(join(dir, 'out.html'), 'utf8')
    expect(out.match(/mailto:/g)).toHaveLength(3)
    for (const address of out.match(ANY_ADDRESS)) expect(address).toMatch(PLACEHOLDER_ADDRESS)
  })

  it('still refuses to write what the personal-data guard would refuse', () => {
    writeFileSync(join(dir, 'in.html'), `<html><body><p>Mail ${applyAddress} or see ${homePath}</p></body></html>`)
    const result = run('--email', join(dir, 'in.html'), join(dir, 'out.html'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('home-path')
    expect(existsSync(join(dir, 'out.html'))).toBe(false)
  })
})
