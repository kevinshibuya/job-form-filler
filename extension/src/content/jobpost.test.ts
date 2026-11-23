import { describe, it, expect, beforeEach, vi } from 'vitest'
import { atsModule, JOB_TEXT_MIN } from '@jff/shared'
import { captureJobText, cssPathOf, MIN_JOB_TEXT, readJobText, startPicker, type PostingReader } from './jobpost'
import { enumeratedControls, enumerateFields, type MeasureFn } from './enumerate'
import { postingFixtureHtml, REAL_FIXTURES, loadRealFixture } from './fixtures/real'
import { fetchPostingText, type FetchLike } from './postingFetch'
import { textOf } from './textOf'

const long = (marker: string): string => `${marker} ` + 'lorem ipsum dolor sit amet '.repeat(30)

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('captureJobText', () => {
  it('uses the learned selector first when it still matches', () => {
    document.body.innerHTML = `<div id="jd">${long('LEARNED')}</div><main>${long('HEURISTIC')}</main>`
    const r = captureJobText(document, '#jd', [])
    expect(r.source).toBe('learned')
    expect(r.text).toContain('LEARNED')
    expect(r.selector).toBe('#jd')
  })

  it('falls back to heuristics when the learned selector no longer matches', () => {
    document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
    const r = captureJobText(document, '#gone', [])
    expect(r.source).toBe('heuristic')
    expect(r.text).toContain('HEURISTIC')
  })

  it('prefers a job-description-ish container over a generic main', () => {
    document.body.innerHTML = `<main>${long('GENERIC')}</main><div class="job-description">${long('SPECIFIC')}</div>`
    expect(captureJobText(document, null, []).text).toContain('SPECIFIC')
  })

  it('picks the longest candidate when several match the same tier', () => {
    document.body.innerHTML = `<article>${long('SHORT')}</article><article>${long('LONGER')}${'x'.repeat(2000)}</article>`
    expect(captureJobText(document, null, []).text).toContain('LONGER')
  })

  // PR #36 manual pass: a Google results page put CSS into the job text.
  it('never reads the text of a style, script, noscript or template', () => {
    document.body.innerHTML = `<main><style>.a{color:red}</style><script>var x=1</script><noscript>enable js</noscript><template>tpl</template><p>${long('POSTING')}</p></main>`
    const r = captureJobText(document, null, [])
    expect(r.text).toContain('POSTING')
    for (const junk of ['color:red', 'var x', 'enable js', 'tpl']) expect(r.text).not.toContain(junk)
  })

  it('a container whose length comes only from a stylesheet holds no job text', () => {
    document.body.innerHTML = `<main><style>${'.a{color:red} '.repeat(60)}</style><p>short</p></main>`
    expect(captureJobText(document, null, []).source).toBe('none')
  })

  it('returns source=none when no candidate holds enough text', () => {
    document.body.innerHTML = `<main>too short</main>`
    const r = captureJobText(document, null, [])
    expect(r).toMatchObject({ source: 'none', text: '', selector: null })
  })

  it('collapses whitespace and caps the returned text', () => {
    document.body.innerHTML = `<main>${'a'.repeat(60_000)}</main>`
    const r = captureJobText(document, null, [])
    expect(r.text.length).toBeLessThanOrEqual(50_000)
  })

  it('requires at least MIN_JOB_TEXT characters', () => {
    document.body.innerHTML = `<main>${'a'.repeat(MIN_JOB_TEXT - 1)}</main>`
    expect(captureJobText(document, null, []).source).toBe('none')
  })

  // Spec #41: the minimum holds for every source but the user's paste.
  it('refuses a heuristic result of 50 characters', () => {
    document.body.innerHTML = `<main>${'a'.repeat(50)}</main>`
    expect(captureJobText(document, null, [])).toMatchObject({ source: 'none', text: '' })
  })

  it('refuses a picked spot that now holds fewer than the minimum, and falls through', () => {
    document.body.innerHTML = `<div id="jd">${'a'.repeat(50)}</div><main>${long('HEURISTIC')}</main>`
    const r = captureJobText(document, '#jd', [])
    expect(r.source).toBe('heuristic')
    expect(r.text).toContain('HEURISTIC')
  })

  it('the minimum is the shared one', () => {
    expect(MIN_JOB_TEXT).toBe(JOB_TEXT_MIN)
  })
})

// Spec #41, #52: the page's part of the order is the ATS module's posting
// page, then the spot the user picked, then a heuristic.
describe('readJobText', () => {
  const APPLY = 'https://jobs.lever.co/acme/0000-posting/apply'
  const fixtureFetch = () => vi.fn<FetchLike>(async () => new Response(postingFixtureHtml('lever-posting'), { status: 200 }))
  const reader = (fetch: FetchLike, id = 'lever', formPageUrl = APPLY): PostingReader => ({ module: atsModule(id), formPageUrl, fetch })

  it('on a Lever apply page reads the posting page first, ahead of a pick and a heuristic', async () => {
    document.body.innerHTML = `<div id="jd">${long('LEARNED')}</div><main>${long('HEURISTIC')}</main>`
    const fetch = fixtureFetch()
    const r = await readJobText(document, '#jd', reader(fetch), [])
    expect(r.source).toBe('ats')
    expect(r.selector).toBeNull()
    expect(r.text).toContain('Placeholder text where the Job posting described the role.')
    expect(r.text).not.toContain('LEARNED')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('goes on to the pick when the posting page cannot be read', async () => {
    document.body.innerHTML = `<div id="jd">${long('LEARNED')}</div><main>${long('HEURISTIC')}</main>`
    const fetch = vi.fn<FetchLike>(async () => { throw new TypeError('Failed to fetch') })
    expect(await readJobText(document, '#jd', reader(fetch), [])).toMatchObject({ source: 'learned', selector: '#jd' })
  })

  it('goes on to the heuristic when the posting page answers with an error', async () => {
    document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
    const fetch = vi.fn<FetchLike>(async () => new Response('', { status: 500 }))
    const r = await readJobText(document, null, reader(fetch), [])
    expect(r.source).toBe('heuristic')
    expect(r.text).toContain('HEURISTIC')
  })

  it('goes on to the next source when the posting page holds less than the minimum', async () => {
    document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
    const fetch = vi.fn<FetchLike>(async () => new Response(`<div class="posting-page">${'a'.repeat(MIN_JOB_TEXT - 1)}</div>`, { status: 200 }))
    expect((await readJobText(document, null, reader(fetch), [])).source).toBe('heuristic')
  })

  it('goes on to the next source when the posting page has not answered after 5 seconds', async () => {
    vi.useFakeTimers()
    try {
      document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
      const fetch = vi.fn<FetchLike>(() => new Promise<Response>(() => {}))
      let reply: Awaited<ReturnType<typeof readJobText>> | undefined
      void readJobText(document, null, reader(fetch), []).then((r) => { reply = r })
      await vi.advanceTimersByTimeAsync(5_001)
      expect(reply?.source).toBe('heuristic')
    } finally {
      vi.useRealTimers()
    }
  })

  it('makes no fetch on an Ashby, a Greenhouse or an unknown page', async () => {
    document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
    const fetch = fixtureFetch()
    for (const [id, url] of [['ashby', 'https://jobs.ashbyhq.com/acme/0000/application'], ['greenhouse', 'https://boards.greenhouse.io/acme/jobs/1'], ['generic', 'https://careers.example/apply']] as const) {
      expect((await readJobText(document, null, reader(fetch, id, url), [])).source).toBe('heuristic')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('makes no fetch on a Lever page that is not an apply page', async () => {
    document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
    const fetch = fixtureFetch()
    expect((await readJobText(document, null, reader(fetch, 'lever', 'https://jobs.lever.co/acme/0000-posting'), [])).source).toBe('heuristic')
    expect(fetch).not.toHaveBeenCalled()
  })
})

// Spec #98, ticket #100: the form's parts never count as Job posting text.
describe('the form region is left out of the heuristic', () => {
  /** Visible unless the element says `display: none` itself. */
  const inlineMeasure: MeasureFn = (el) => ({
    display: (el as HTMLElement).style.display === 'none' ? 'none' : 'block',
    visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false,
  })

  /** Enumerates the document as the Scan does first, and gives its Controls. */
  function scanned(measure: MeasureFn = inlineMeasure): readonly Element[] {
    enumerateFields({ root: document, epoch: 9, measure })
    return enumeratedControls()
  }

  const question = (i: number): string => `
    <div class="question">
      <label for="q${i}">QUESTION-${i}: Describe a project where you improved the performance of a web application, and how you measured it.</label>
      <p class="note">NOTE-${i}: Maximum 500 characters</p>
      <textarea id="q${i}" name="q${i}"></textarea>
    </div>`
  const FORM = `<form id="application">${[1, 2, 3, 4].map(question).join('')}<button type="submit">Submit application</button></form>`
  const POSTING = `<h1>Senior Engineer</h1><p>${long('POSTING')}</p>`
  const leftOut = ['QUESTION-', 'NOTE-', 'Maximum 500 characters']

  it('a page whose main content is a form of four questions gives nothing', () => {
    document.body.innerHTML = `<main><h1>Apply: Senior Engineer</h1>${FORM}<footer>Powered by an ATS. Privacy policy.</footer></main>`
    // Without the rule the heuristic would read the questions as the posting.
    expect(captureJobText(document, null, []).source).toBe('heuristic')
    expect(captureJobText(document, null, scanned())).toEqual({ text: '', selector: null, source: 'none' })
  })

  it('a posting above a form in the same container gives the posting, without the form region\'s text', () => {
    document.body.innerHTML = `<main>${POSTING}${FORM}</main>`
    const r = captureJobText(document, null, scanned())
    expect(r.source).toBe('heuristic')
    expect(r.text).toContain('POSTING')
    for (const part of leftOut) expect(r.text).not.toContain(part)
  })

  it('applies the minimum to what is left of a candidate', () => {
    document.body.innerHTML = `<main><p>${'a'.repeat(MIN_JOB_TEXT - 10)}</p>${FORM}</main>`
    expect(captureJobText(document, null, scanned()).source).toBe('none')
  })

  it('a page with a search box in the header and the application below loses only those two regions', () => {
    document.body.innerHTML = `
      <main>
        <header><form id="search"><span>HEADER-KEPT</span>
          <div id="search-box"><label>SEARCH-LABEL keyword <input name="kw"></label><label>SEARCH-TEAM <select name="team"><option>All</option></select></label></div>
        </form></header>
        ${POSTING}
        ${FORM}
        <p>AFTER-KEPT</p>
      </main>`
    const r = captureJobText(document, null, scanned())
    expect(r.source).toBe('heuristic')
    for (const kept of ['HEADER-KEPT', 'POSTING', 'AFTER-KEPT']) expect(r.text).toContain(kept)
    for (const part of ['SEARCH-LABEL', 'SEARCH-TEAM', ...leftOut]) expect(r.text).not.toContain(part)
  })

  it('leaves out the smallest common element of Controls outside any form element', () => {
    document.body.innerHTML = `<main>${POSTING}<div class="questions">${[1, 2].map(question).join('')}</div><p>AFTER-KEPT</p></main>`
    const r = captureJobText(document, null, scanned())
    expect(r.text).toContain('POSTING')
    expect(r.text).toContain('AFTER-KEPT')
    for (const part of leftOut) expect(r.text).not.toContain(part)
  })

  it('a hidden Control at the end of the page, outside any form, does not widen the region', () => {
    document.body.innerHTML = `
      <main>${POSTING}<div class="questions">${[1, 2].map(question).join('')}</div></main>
      <footer><input name="tracking" style="display: none"></footer>`
    const r = captureJobText(document, null, scanned())
    expect(r.source).toBe('heuristic')
    expect(r.text).toContain('POSTING')
    // Counted as seen, the hidden box would stretch the region to the body.
    expect(captureJobText(document, null, scanned(() => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false }))).source).toBe('none')
  })

  it('a page whose region is the whole document gives nothing', () => {
    document.body.innerHTML = `<header><input name="kw"></header><main>${POSTING}</main><footer><textarea name="note"></textarea></footer>`
    expect(captureJobText(document, null, scanned())).toEqual({ text: '', selector: null, source: 'none' })
  })

  it('a spot the user picked that holds a form is returned whole', () => {
    document.body.innerHTML = `<div id="jd">${POSTING}${FORM}</div>`
    const r = captureJobText(document, '#jd', scanned())
    expect(r).toMatchObject({ source: 'learned', selector: '#jd' })
    expect(r.text).toContain('POSTING')
    expect(r.text).toContain('QUESTION-1')
  })

  it('the Lever posting-page read returns what it returned before', async () => {
    document.body.innerHTML = `<main>${FORM}</main>`
    const APPLY = 'https://jobs.lever.co/acme/0000-posting/apply'
    const fetch = vi.fn<FetchLike>(async () => new Response(postingFixtureHtml('lever-posting'), { status: 200 }))
    const before = await fetchPostingText(atsModule('lever'), APPLY, fetch)
    expect(before).not.toBeNull()
    const r = await readJobText(document, null, { module: atsModule('lever'), formPageUrl: APPLY, fetch }, scanned())
    expect(r).toEqual({ text: before, selector: null, source: 'ats' })
  })

  it('the browser tests\' single-page application fixture gives the same Job posting text as before', () => {
    const html = Object.values(SPA_FIXTURE)[0]!
    document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '')
    const posting = document.getElementById('job-description')!
    const before = { text: textOf(posting), selector: '#job-description', source: 'heuristic' }
    expect(captureJobText(document, null, [])).toEqual(before)
    const controls = scanned((el) => {
      const st = window.getComputedStyle(el)
      return { display: st.display, visibility: st.visibility, ariaHidden: false, width: 200, height: 30, clipped: false }
    })
    expect(controls.length).toBeGreaterThan(0)
    expect(captureJobText(document, null, controls)).toEqual(before)
  })

  // Each real form fixture holds a form and no posting. Named here, so a new
  // fixture is a choice to make, not one taken silently.
  const FORM_ONLY_FIXTURES = [
    'based-in-yes-no',
    'greenhouse-accommodation',
    'greenhouse-hosted-a',
    'greenhouse-hosted-b',
    'greenhouse-hosted-resume-attached',
    'greenhouse-hosted-resume-uploading',
    'greenhouse-self-id',
    'lever-marketing-consent',
    'lever-pronoun-group',
    'lever-source-group',
    'listing-language-dropdown',
    'recruitee-file-inputs',
  ]

  it('names every real form fixture', () => {
    expect([...FORM_ONLY_FIXTURES].sort()).toEqual(REAL_FIXTURES)
  })

  it.each(FORM_ONLY_FIXTURES)('the real form fixture %s gives no Job posting text', (name) => {
    loadRealFixture(name)
    expect(captureJobText(document, null, scanned(() => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })))).toEqual({ text: '', selector: null, source: 'none' })
  })
})

const SPA_FIXTURE = import.meta.glob<string>('../../../e2e/fixtures/greenhouse-apply/fixture-form.html', { query: '?raw', import: 'default', eager: true })

describe('cssPathOf', () => {
  it('uses an id when the element has one', () => {
    document.body.innerHTML = `<div id="jd"><p id="target">x</p></div>`
    expect(cssPathOf(document.getElementById('target')!)).toBe('#target')
  })

  it('builds a nth-of-type path when there is no id', () => {
    document.body.innerHTML = `<div id="wrap"><p>a</p><p>b</p></div>`
    const el = document.querySelectorAll('p')[1]!
    const path = cssPathOf(el)
    expect(path).toBe('#wrap > p:nth-of-type(2)')
    expect(document.querySelector(path)).toBe(el)
  })

  it('produces a selector that resolves back to the same element without any id anywhere', () => {
    document.body.innerHTML = `<section><div><span>a</span><span>b</span></div></section>`
    const el = document.querySelectorAll('span')[1]!
    expect(document.querySelector(cssPathOf(el))).toBe(el)
  })
})

describe('startPicker', () => {
  it('reports the clicked element as a selector and its text', () => {
    document.body.innerHTML = `<div id="jd">${long('PICKED')}</div>`
    const picks: ({ selector: string; text: string } | null)[] = []
    startPicker(document, (p) => picks.push(p))
    document.getElementById('jd')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(picks).toHaveLength(1)
    expect(picks[0]).toMatchObject({ selector: '#jd' })
    expect(picks[0]!.text).toContain('PICKED')
  })

  it('settles with null on Escape, so the caller never waits forever', () => {
    document.body.innerHTML = `<div id="jd">x</div>`
    const picks: ({ selector: string; text: string } | null)[] = []
    startPicker(document, (p) => picks.push(p))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(picks).toEqual([null])
  })

  it('restores the outline it borrowed from the highlighted element', () => {
    document.body.innerHTML = `<div id="jd" style="outline: 1px dotted red">x</div>`
    const el = document.getElementById('jd')!
    const before = el.style.outline // read it back rather than assuming jsdom's serialisation
    startPicker(document, () => undefined)
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(el.style.outline).not.toBe(before)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(el.style.outline).toBe(before)
  })
})
