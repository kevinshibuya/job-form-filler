import { describe, it, expect, beforeEach, vi } from 'vitest'
import { atsModule, JOB_TEXT_MIN } from '@jff/shared'
import { captureJobText, cssPathOf, MIN_JOB_TEXT, readJobText, startPicker, type PostingReader } from './jobpost'
import { postingFixtureHtml } from './fixtures/real'
import type { FetchLike } from './postingFetch'

const long = (marker: string): string => `${marker} ` + 'lorem ipsum dolor sit amet '.repeat(30)

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('captureJobText', () => {
  it('uses the learned selector first when it still matches', () => {
    document.body.innerHTML = `<div id="jd">${long('LEARNED')}</div><main>${long('HEURISTIC')}</main>`
    const r = captureJobText(document, '#jd')
    expect(r.source).toBe('learned')
    expect(r.text).toContain('LEARNED')
    expect(r.selector).toBe('#jd')
  })

  it('falls back to heuristics when the learned selector no longer matches', () => {
    document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
    const r = captureJobText(document, '#gone')
    expect(r.source).toBe('heuristic')
    expect(r.text).toContain('HEURISTIC')
  })

  it('prefers a job-description-ish container over a generic main', () => {
    document.body.innerHTML = `<main>${long('GENERIC')}</main><div class="job-description">${long('SPECIFIC')}</div>`
    expect(captureJobText(document, null).text).toContain('SPECIFIC')
  })

  it('picks the longest candidate when several match the same tier', () => {
    document.body.innerHTML = `<article>${long('SHORT')}</article><article>${long('LONGER')}${'x'.repeat(2000)}</article>`
    expect(captureJobText(document, null).text).toContain('LONGER')
  })

  // PR #36 manual pass: a Google results page put CSS into the job text.
  it('never reads the text of a style, script, noscript or template', () => {
    document.body.innerHTML = `<main><style>.a{color:red}</style><script>var x=1</script><noscript>enable js</noscript><template>tpl</template><p>${long('POSTING')}</p></main>`
    const r = captureJobText(document, null)
    expect(r.text).toContain('POSTING')
    for (const junk of ['color:red', 'var x', 'enable js', 'tpl']) expect(r.text).not.toContain(junk)
  })

  it('a container whose length comes only from a stylesheet holds no job text', () => {
    document.body.innerHTML = `<main><style>${'.a{color:red} '.repeat(60)}</style><p>short</p></main>`
    expect(captureJobText(document, null).source).toBe('none')
  })

  it('returns source=none when no candidate holds enough text', () => {
    document.body.innerHTML = `<main>too short</main>`
    const r = captureJobText(document, null)
    expect(r).toMatchObject({ source: 'none', text: '', selector: null })
  })

  it('collapses whitespace and caps the returned text', () => {
    document.body.innerHTML = `<main>${'a'.repeat(60_000)}</main>`
    const r = captureJobText(document, null)
    expect(r.text.length).toBeLessThanOrEqual(50_000)
  })

  it('requires at least MIN_JOB_TEXT characters', () => {
    document.body.innerHTML = `<main>${'a'.repeat(MIN_JOB_TEXT - 1)}</main>`
    expect(captureJobText(document, null).source).toBe('none')
  })

  // Spec #41: the minimum holds for every source but the user's paste.
  it('refuses a heuristic result of 50 characters', () => {
    document.body.innerHTML = `<main>${'a'.repeat(50)}</main>`
    expect(captureJobText(document, null)).toMatchObject({ source: 'none', text: '' })
  })

  it('refuses a picked spot that now holds fewer than the minimum, and falls through', () => {
    document.body.innerHTML = `<div id="jd">${'a'.repeat(50)}</div><main>${long('HEURISTIC')}</main>`
    const r = captureJobText(document, '#jd')
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
    const r = await readJobText(document, '#jd', reader(fetch))
    expect(r.source).toBe('ats')
    expect(r.selector).toBeNull()
    expect(r.text).toContain('Placeholder text where the Job posting described the role.')
    expect(r.text).not.toContain('LEARNED')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('goes on to the pick when the posting page cannot be read', async () => {
    document.body.innerHTML = `<div id="jd">${long('LEARNED')}</div><main>${long('HEURISTIC')}</main>`
    const fetch = vi.fn<FetchLike>(async () => { throw new TypeError('Failed to fetch') })
    expect(await readJobText(document, '#jd', reader(fetch))).toMatchObject({ source: 'learned', selector: '#jd' })
  })

  it('goes on to the heuristic when the posting page answers with an error', async () => {
    document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
    const fetch = vi.fn<FetchLike>(async () => new Response('', { status: 500 }))
    const r = await readJobText(document, null, reader(fetch))
    expect(r.source).toBe('heuristic')
    expect(r.text).toContain('HEURISTIC')
  })

  it('goes on to the next source when the posting page holds less than the minimum', async () => {
    document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
    const fetch = vi.fn<FetchLike>(async () => new Response(`<div class="posting-page">${'a'.repeat(MIN_JOB_TEXT - 1)}</div>`, { status: 200 }))
    expect((await readJobText(document, null, reader(fetch))).source).toBe('heuristic')
  })

  it('goes on to the next source when the posting page has not answered after 5 seconds', async () => {
    vi.useFakeTimers()
    try {
      document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
      const fetch = vi.fn<FetchLike>(() => new Promise<Response>(() => {}))
      let reply: Awaited<ReturnType<typeof readJobText>> | undefined
      void readJobText(document, null, reader(fetch)).then((r) => { reply = r })
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
      expect((await readJobText(document, null, reader(fetch, id, url))).source).toBe('heuristic')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('makes no fetch on a Lever page that is not an apply page', async () => {
    document.body.innerHTML = `<main>${long('HEURISTIC')}</main>`
    const fetch = fixtureFetch()
    expect((await readJobText(document, null, reader(fetch, 'lever', 'https://jobs.lever.co/acme/0000-posting'))).source).toBe('heuristic')
    expect(fetch).not.toHaveBeenCalled()
  })
})

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
