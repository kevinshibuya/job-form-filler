import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIN_JOB_TEXT, postingRoot } from '@jff/shared'
import { sanitizeCapture } from './sanitize-capture.mjs'

// Every offending sample is assembled at run time, so this file never holds a
// string the guard would refuse to commit.
const web = ['https', ''].join(':') + '//'
const homePath = ['', 'Users', 'janedoe', 'notes.md'].join('/')
const postingId = ['1a2b3c4d', '5e6f', '4a7b', '8c9d', '0e1f2a3b4c5d'].join('-')

const SCRIPT = fileURLToPath(new URL('./sanitize-capture.mjs', import.meta.url))

function parse(html) {
  return new JSDOM(html).window.document
}

/** Words of the posting that must not survive the cut. */
const PROSE = [
  'Senior Platform Engineer',
  'Initech builds TPS reports',
  'Own the build pipeline',
  'Five years of distributed systems',
  'Equity and a four-day week',
  'Austin, Texas',
  'Engineering',
  'Full-time',
  'What you will do',
  'What we offer',
  'The platform team keeps',
]

/** A Job posting page: site chrome around one posting, and no form. */
const postingPage = `<!doctype html><html lang="en"><head>
  <title>Initech - Senior Platform Engineer</title>
  <meta property="og:url" content="${web}jobs.lever.co/initech/${postingId}">
  <script>window.posting = '${postingId}'</script>
</head><body>
  <header class="main-header"><a href="${web}initech.example.org">Initech home</a><p>Join us, we are hiring</p></header>
  <div class="content-wrapper posting-page" data-posting-id="${postingId}">
    <div class="posting-header">
      <div class="posting-headline">
        <h2>Senior Platform Engineer</h2>
        <div class="posting-categories">
          <div class="location">Austin, Texas</div>
          <div class="department">Engineering</div>
          <div class="commitment">Full-time</div>
        </div>
      </div>
      <a class="postings-btn" href="${web}jobs.lever.co/initech/${postingId}/apply">Apply for this job</a>
    </div>
    <div class="section" data-qa="job-description">
      <p>Initech builds TPS reports for the whole world, see ${web}initech.example.org/about for more.</p>
      <p>The platform team keeps every service of the company running, from the build farm to the release train, and it answers for the reliability of the products our customers use every day.</p>
    </div>
    <div class="section">
      <h3>What you will do</h3>
      <ul class="posting-requirements"><li>Own the build pipeline</li><li>Five years of distributed systems</li></ul>
    </div>
    <div class="section">
      <h3>What we offer</h3>
      <ul class="posting-requirements"><li>Equity and a four-day week</li></ul>
    </div>
  </div>
  <footer><p>Initech, 1 Main Street</p></footer>
</body></html>`

describe('sanitizeCapture with the posting cut', () => {
  const clean = sanitizeCapture(postingPage, [], { posting: true })
  const doc = parse(clean)
  const posting = doc.querySelector('.posting-page')

  it('keeps the element that holds the posting and its ancestors, and no other element', () => {
    expect(posting).not.toBeNull()
    const outside = [...doc.body.querySelectorAll('*')].filter((el) => !posting.contains(el) && !el.contains(posting))
    expect(outside.map((el) => el.tagName)).toEqual([])
    expect(doc.querySelector('header, footer')).toBeNull()
  })

  it('keeps the posting\'s headings and containers', () => {
    expect(posting.querySelector('.posting-headline > h2')).not.toBeNull()
    expect(posting.querySelectorAll('h3')).toHaveLength(2)
    expect(posting.querySelectorAll('.section')).toHaveLength(3)
    expect(posting.querySelector('[data-qa="job-description"] > p')).not.toBeNull()
    expect(posting.querySelectorAll('ul.posting-requirements > li')).toHaveLength(3)
    expect(posting.querySelectorAll('.posting-categories > div')).toHaveLength(3)
    expect(posting.querySelector('a.postings-btn').textContent).toBe('Apply for this job')
  })

  it('holds none of the original prose', () => {
    for (const words of PROSE) expect(clean).not.toContain(words)
  })

  it('holds at least the tool\'s minimum of text inside the posting\'s element', () => {
    const text = (posting.textContent ?? '').replace(/\s+/g, ' ').trim()
    expect(text.length).toBeGreaterThanOrEqual(MIN_JOB_TEXT)
  })

  it('holds no absolute address, no board path and no Job posting id, and names the Company "Acme"', () => {
    expect(clean).not.toMatch(/https?:\/\//)
    expect(clean).not.toMatch(/initech/i)
    expect(clean).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
    expect(clean).not.toContain('jobs.lever.co/')
    expect(doc.title).toContain('Acme')
    expect(doc.title).not.toContain('Platform Engineer')
  })

  it('drops scripts as the privacy step does on a form page', () => {
    expect(doc.querySelector('script, meta[property]')).toBeNull()
    expect(posting.querySelector('a').getAttribute('href')).toBe('')
  })

  it('pads a short posting up to the minimum', () => {
    const short = '<html><head><title>Initech - Engineer</title></head><body><main><h1>Engineer</h1><p>' +
      'Short posting text at Initech. '.repeat(14) + '</p></main></body></html>'
    const out = parse(sanitizeCapture(short, [], { posting: true }))
    const text = (out.querySelector('main').textContent ?? '').replace(/\s+/g, ' ').trim()
    expect(text.length).toBeGreaterThanOrEqual(MIN_JOB_TEXT)
    expect(out.querySelectorAll('main > *')).toHaveLength(2)
  })

  it('finds the same posting element on the fixture it wrote', () => {
    expect(postingRoot(doc)).toBe(posting)
  })

  it('refuses a page that holds no posting', () => {
    expect(() => sanitizeCapture('<html><body><p>Cookies.</p></body></html>', [], { posting: true })).toThrow(/no Job posting/)
  })
})

describe('the sanitize-capture CLI with --posting', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jff-posting-'))
    writeFileSync(join(dir, 'denylist.txt'), 'springfield heights\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, JFF_PRIVATE_STRINGS: join(dir, 'denylist.txt') },
    })

  it('writes the cut posting', () => {
    writeFileSync(join(dir, 'in.html'), postingPage)
    const result = run('--posting', join(dir, 'in.html'), join(dir, 'out.html'))
    expect(result.status).toBe(0)
    const out = readFileSync(join(dir, 'out.html'), 'utf8')
    expect(out).toContain('posting-page')
    expect(out).not.toMatch(/initech/i)
  })

  it('refuses a posting page that holds a private string, as it refuses a form page', () => {
    // The prose is replaced, so the string sits where the cut keeps text: an attribute.
    writeFileSync(join(dir, 'in.html'), postingPage.replace('<h3>What we offer</h3>', `<h3 aria-label="Notes in ${homePath}">What we offer</h3>`))
    const result = run('--posting', join(dir, 'in.html'), join(dir, 'out.html'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('home-path')
    expect(existsSync(join(dir, 'out.html'))).toBe(false)
  })
})
