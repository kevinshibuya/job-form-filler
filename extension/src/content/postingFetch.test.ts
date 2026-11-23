import { afterEach, describe, expect, it, vi } from 'vitest'
import { atsModule, JOB_TEXT_MIN, type AtsModule } from '@jff/shared'
import { fetchPostingText, POSTING_FETCH_TIMEOUT_MS, type FetchLike } from './postingFetch'
import { postingFixtureHtml } from './fixtures/real'

// Spec #41, #52: on a Lever apply page the Job posting text is read from the
// posting's own page. The fetch is stubbed; the answer is the Lever posting
// fixture as a server would send it.

const APPLY = 'https://jobs.lever.co/acme/0000-posting/apply'
const POSTING = 'https://jobs.lever.co/acme/0000-posting'
const lever = atsModule('lever')

const answer = (html: string, init: ResponseInit = {}): Response =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html' }, ...init })

/** A fetch that answers every request with `html`, and records each call. */
function stubFetch(html = postingFixtureHtml('lever-posting')) {
  return vi.fn<FetchLike>(async () => answer(html))
}

/** A made-up module whose rule gives the address `to` for any form page. */
const ruleTo = (to: string): AtsModule => ({ id: 'lever', jobText: { postingPage: () => ({ url: to, spot: 'main' }) } })

const page = (body: string): string => `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`
const posting = (marker: string): string => `${marker} ${'lorem ipsum dolor sit amet '.repeat(30)}`

afterEach(() => { vi.useRealTimers() })

describe('the Lever module\'s Job posting text rule', () => {
  const rule = lever.jobText?.postingPage

  it('gives the apply address without its last segment', () => {
    expect(rule?.(APPLY)?.url).toBe(POSTING)
  })

  it('gives the same posting address for an apply address with a trailing slash or a query', () => {
    expect(rule?.(`${APPLY}/`)?.url).toBe(POSTING)
    expect(rule?.(`${APPLY}?source=board`)?.url).toBe(POSTING)
  })

  it('gives nothing for a Lever address that is not an apply page', () => {
    expect(rule?.(POSTING)).toBeNull()
    expect(rule?.('https://jobs.lever.co/acme')).toBeNull()
    expect(rule?.('https://jobs.lever.co/apply')).toBeNull()
  })

  it('gives nothing for a string that is no address', () => {
    expect(rule?.('not an address')).toBeNull()
  })

  it('says where the text sits on the posting page, read from the Lever posting fixture', () => {
    const doc = new DOMParser().parseFromString(postingFixtureHtml('lever-posting'), 'text/html')
    const spot = rule?.(APPLY)?.spot
    expect(spot).toBeTruthy()
    const el = doc.querySelector(spot!)
    expect(el).not.toBeNull()
    expect((el!.textContent ?? '').replace(/\s+/g, ' ').trim().length).toBeGreaterThanOrEqual(JOB_TEXT_MIN)
  })

  it('names no text on the form\'s own page, for any module', () => {
    for (const id of ['lever', 'ashby', 'greenhouse', 'generic']) expect(Object.keys(atsModule(id).jobText ?? {})).not.toContain('onFormPage')
  })

  it('is Lever\'s alone: Ashby, Greenhouse and the generic module give no posting page', () => {
    for (const id of ['ashby', 'greenhouse', 'generic']) expect(atsModule(id).jobText?.postingPage).toBeUndefined()
  })
})

describe('fetchPostingText', () => {
  it('reads the posting\'s text from the posting page, with the fixture as the answer', async () => {
    const fetch = stubFetch()
    const text = await fetchPostingText(lever, APPLY, fetch)
    expect(text).not.toBeNull()
    expect(text!.length).toBeGreaterThanOrEqual(JOB_TEXT_MIN)
    expect(text).toContain('Placeholder text where the Job posting described the role.')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![0]).toBe(POSTING)
  })

  it('sends no cookies', async () => {
    const fetch = stubFetch()
    await fetchPostingText(lever, APPLY, fetch)
    expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' })
  })

  it('makes no fetch when the rule gives an address on another origin', async () => {
    const fetch = stubFetch(page(`<main>${posting('ELSEWHERE')}</main>`))
    expect(await fetchPostingText(ruleTo('https://evil.example/acme/0000-posting'), APPLY, fetch)).toBeNull()
    expect(await fetchPostingText(ruleTo('http://jobs.lever.co/acme/0000-posting'), APPLY, fetch)).toBeNull()
    expect(await fetchPostingText(ruleTo('https://jobs.lever.co:8443/acme/0000-posting'), APPLY, fetch)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches when a made-up module\'s rule gives an address on the same origin', async () => {
    const fetch = stubFetch(page(`<main>${posting('SAME')}</main>`))
    expect(await fetchPostingText(ruleTo('https://jobs.lever.co/elsewhere'), APPLY, fetch)).toContain('SAME')
  })

  it('makes no fetch for a module with no posting page rule, or a rule that gives nothing', async () => {
    const fetch = stubFetch()
    for (const id of ['ashby', 'greenhouse', 'generic']) {
      expect(await fetchPostingText(atsModule(id), APPLY, fetch)).toBeNull()
    }
    expect(await fetchPostingText(lever, POSTING, fetch)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it(`gives up after ${POSTING_FETCH_TIMEOUT_MS} ms and aborts the request`, async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetch = vi.fn<FetchLike>((_url, init) => { signal = init.signal ?? undefined; return new Promise<Response>(() => {}) })
    let settled: string | null | undefined
    void fetchPostingText(lever, APPLY, fetch).then((t) => { settled = t })
    await vi.advanceTimersByTimeAsync(POSTING_FETCH_TIMEOUT_MS - 1)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toBeNull()
    expect(signal?.aborted).toBe(true)
  })

  it('the limit is 5 seconds', () => {
    expect(POSTING_FETCH_TIMEOUT_MS).toBe(5_000)
  })

  it('gives up on an answer whose body has not come after the limit', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 200, url: POSTING, text: () => new Promise<string>(() => {}) }) as unknown as Response)
    let settled: string | null | undefined
    void fetchPostingText(lever, APPLY, fetch).then((t) => { settled = t })
    await vi.advanceTimersByTimeAsync(POSTING_FETCH_TIMEOUT_MS + 1)
    expect(settled).toBeNull()
  })

  it('gives nothing when the fetch answers with an error status', async () => {
    const fetch = vi.fn<FetchLike>(async () => answer(postingFixtureHtml('lever-posting'), { status: 404 }))
    expect(await fetchPostingText(lever, APPLY, fetch)).toBeNull()
  })

  it('gives nothing when the fetch throws', async () => {
    const fetch = vi.fn<FetchLike>(async () => { throw new TypeError('Failed to fetch') })
    expect(await fetchPostingText(lever, APPLY, fetch)).toBeNull()
  })

  it('gives nothing when the answer ended on another origin', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      const res = answer(postingFixtureHtml('lever-posting'))
      Object.defineProperty(res, 'url', { value: 'https://evil.example/landing' })
      return res
    })
    expect(await fetchPostingText(lever, APPLY, fetch)).toBeNull()
  })

  it('gives nothing when the spot holds fewer than the minimum', async () => {
    const fetch = stubFetch(page(`<div class="posting-page">${'a'.repeat(JOB_TEXT_MIN - 1)}</div>`))
    expect(await fetchPostingText(lever, APPLY, fetch)).toBeNull()
  })

  it('gives nothing when the page has no such spot', async () => {
    const fetch = stubFetch(page(`<main>${posting('NO SPOT')}</main>`))
    expect(await fetchPostingText(lever, APPLY, fetch)).toBeNull()
  })

  it('cuts the text to the 50,000-character cap', async () => {
    const fetch = stubFetch(page(`<div class="posting-page">${'a'.repeat(60_000)}</div>`))
    expect(await fetchPostingText(lever, APPLY, fetch)).toHaveLength(50_000)
  })

  it('leaves out script, style, noscript and template text', async () => {
    const fetch = stubFetch(page(`<div class="posting-page"><script>var leaked = 1</script><style>.a{color:red}</style><noscript>enable js</noscript><template>tpl</template><p>${posting('POSTING')}</p></div>`))
    const text = await fetchPostingText(lever, APPLY, fetch)
    expect(text).toContain('POSTING')
    for (const junk of ['var leaked', 'color:red', 'enable js', 'tpl']) expect(text).not.toContain(junk)
  })

  it('parses the page without running anything in it', async () => {
    const w = window as unknown as { __jffRan?: boolean }
    delete w.__jffRan
    const fetch = stubFetch(page(`<div class="posting-page"><script>window.__jffRan = true</script><img src="x" onerror="window.__jffRan = true"><p>${posting('POSTING')}</p></div>`))
    expect(await fetchPostingText(lever, APPLY, fetch)).toContain('POSTING')
    await new Promise((r) => setTimeout(r, 0))
    expect(w.__jffRan).toBeUndefined()
  })
})
