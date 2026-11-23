import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { EnumField, FoundAddress, HostResponse, Resolution } from '@jff/shared'
import { App } from './App'
import type { FetchLike } from '../content/postingFetch'
import { POSTING_FETCH_TIMEOUT_MS } from '../content/postingFetch'
import { LINK_FAILED, POSTING_LINK_MAX_BYTES, readPostingLink } from './postingLink'
import type { Session } from './sessions'
import { field, installHeldMappingHost, mapped, release, resolution, rowOf, status } from './testing/heldMapping'

/**
 * The posting's link (spec #98, ticket #104), the Side panel rendered with a
 * fake Native host. The user types the address of a posting that sits on
 * another page; the panel fetches it with no cookies, parses the reply as an
 * inert document and reads its text with the page heuristic, form elements
 * left out. The fetch is a stub handed in, as the posting-page read's is.
 */

const host = installHeldMappingHost()

const PAGE_URL = 'https://jobs.example.com/apply'
const LINK = 'https://careers.example.com/jobs/analyst'

const JD = `JOB POSTING Ada Lovelace's team builds analytical engines. ${'Build reliable systems with a small team. '.repeat(12)}`.trim()
const PAGE_JD = `PAGE POSTING ${'Ship careful software for the analytical engine. '.repeat(12)}`.trim()

/** A served posting page: the posting in a job description container, with a
 *  form, a script, a style and a template around and inside it. */
const servedPage = (posting = JD, extra = ''): string => `<!DOCTYPE html><html><head><title>Analyst</title>
<style>.STYLE_MARKER { color: red }</style><script>var SCRIPT_MARKER = 1</script></head>
<body><main><div class="job-description"><p>${posting}</p>
<form><label>FORM_MARKER Why do you want this role? ${'Tell us more about yourself. '.repeat(20)}</label><textarea name="why"></textarea></form>
<template>TEMPLATE_MARKER</template><script>var INLINE_SCRIPT_MARKER = 2</script><noscript>NOSCRIPT_MARKER</noscript></div>
<form class="job-posting"><p>APPLY_FORM_MARKER ${'Answer every question below. '.repeat(30)}</p><input name="email"></form>${extra}</main></body></html>`

const answer = (html: string, init: ResponseInit = {}): Response =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })

type Chrome = { runtime: { sendMessage: (msg: unknown) => Promise<unknown> }; tabs: { query: unknown; get: unknown } }

let fetchLink: ReturnType<typeof vi.fn<FetchLike>>
/** How many times the page was asked for its job text. */
let jobTextAsks: number
/** Every `generate` request, as its params. */
let generates: Record<string, unknown>[]

beforeEach(() => {
  fetchLink = vi.fn<FetchLike>(async () => answer(servedPage()))
  jobTextAsks = 0
  generates = []
  host.fields = [field(0, 'Email'), field(1, 'Why us?')]
  host.nothingPending = true
  const chrome = (globalThis as unknown as { chrome: Chrome }).chrome
  const tab = { id: 7, url: PAGE_URL, title: 'Analyst at Example' }
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
  const relay = chrome.runtime.sendMessage
  chrome.runtime.sendMessage = async (msg: unknown) => {
    const m = msg as { kind?: string; message?: { type?: string } }
    if (m.kind === 'toContent' && m.message?.type === 'JFF_JOBTEXT') jobTextAsks++
    return relay(msg)
  }
  const bridge = window.__jffHostBridge!
  window.__jffHostBridge = async (req): Promise<HostResponse> => {
    if (req.method === 'generate') {
      generates.push(req.params as Record<string, unknown>)
      return { requestId: req.requestId, ok: true, result: { draft: 'A drafted answer.', model: 'claude-test-writer' } }
    }
    return bridge(req)
  }
})

afterEach(() => { vi.useRealTimers() })

const line = (): string => document.querySelector('[data-jff-jobtext-source]')?.textContent ?? ''
const ways = (): string => document.querySelector('[data-jff-jobtext-ways]')?.textContent ?? ''
const box = (): HTMLTextAreaElement => document.querySelector('[data-jff-paste] textarea') as HTMLTextAreaElement
const linkInput = (): HTMLInputElement => document.querySelector('[data-jff-link] input') as HTMLInputElement
const readButton = (): HTMLButtonElement => within(document.querySelector('[data-jff-link]') as HTMLElement).getByRole('button') as HTMLButtonElement
const failure = (): string | null => document.querySelector('[data-jff-link-failed]')?.textContent ?? null
const refusal = (): string | null => document.querySelector('[data-jff-link-refused]')?.textContent ?? null
const rejectButton = (): HTMLButtonElement | null => screen.queryByRole('button', { name: 'Not the job description' })
const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined

async function mountAndScan(): Promise<() => void> {
  const { unmount } = render(<App fetchLink={fetchLink} />)
  await waitFor(() => { expect(status()).toBe('done') }, { timeout: 8_000 })
  return unmount
}

function typeLink(address: string): void {
  fireEvent.change(linkInput(), { target: { value: address } })
  fireEvent.click(readButton())
}

async function readLink(address = LINK): Promise<void> {
  typeLink(address)
  await waitFor(() => { expect(box().value).toBe(JD) })
}

async function scanAgain(): Promise<void> {
  const scans = host.scans
  fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
  await waitFor(() => { expect(host.scans).toBeGreaterThan(scans) })
  await waitFor(() => { expect(status()).toBe('done') })
}

/** A wizard step: the bound tab commits a new page on the same site. */
async function nextStep(): Promise<void> {
  const scans = host.scans
  const onCommitted = (globalThis as unknown as {
    chrome: { webNavigation: { onCommitted: { addListener: ReturnType<typeof vi.fn> } } }
  }).chrome.webNavigation.onCommitted.addListener
  await waitFor(() => { expect(onCommitted.mock.calls.length).toBeGreaterThan(0) })
  const listener = onCommitted.mock.calls[onCommitted.mock.calls.length - 1]![0] as (d: { tabId: number; frameId: number; url: string }) => void
  await act(async () => { listener({ tabId: 7, frameId: 0, url: 'https://jobs.example.com/apply/step2' }) })
  await waitFor(() => { expect(host.scans).toBeGreaterThan(scans) }, { timeout: 5_000 })
  await waitFor(() => { expect(status()).toBe('done') })
}

/** Fails the link read with each way a reply can fail, and checks the one
 *  message shows and the Session's text, source and link stay. */
async function expectFailureLeavesSession(): Promise<void> {
  await waitFor(() => { expect(failure()).toBe(LINK_FAILED) })
  expect(box().value).toBe(PAGE_JD)
  expect(line()).toBe(`${PAGE_JD.length} characters · a heuristic`)
  await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: PAGE_JD, jobTextSource: 'heuristic', jobTextLink: null }) })
}

describe('the address', () => {
  it('an https address is fetched once, with no cookies, following redirects', async () => {
    await mountAndScan()
    await readLink()
    expect(fetchLink).toHaveBeenCalledTimes(1)
    expect(fetchLink.mock.calls[0]![0]).toBe(LINK)
    expect(fetchLink.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'follow' })
  })

  it('an http address is fetched too', async () => {
    await mountAndScan()
    await readLink('http://careers.example.com/jobs/analyst')
    expect(fetchLink).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ftp://careers.example.com/jobs/analyst'],
    ['file:///home/ada/posting.html'],
    ['javascript:alert(1)'],
    ['data:text/html,<p>posting</p>'],
    ['careers.example.com/jobs/analyst'],
    ['not an address'],
    [''],
  ])('%j is refused in the box and nothing is fetched', async (address) => {
    await mountAndScan()
    typeLink(address)
    await waitFor(() => { expect(refusal()).not.toBeNull() })
    expect(refusal()).toMatch(/http/)
    expect(fetchLink).not.toHaveBeenCalled()
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobTextLink: null }) })
  })
})

describe('a served posting', () => {
  it('fills the box, and the line reads the count and "your link"', async () => {
    await mountAndScan()
    await readLink()
    expect(line()).toBe(`${JD.length} characters · your link`)
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: JD, jobTextSource: 'link', jobTextLink: LINK, jobTextSpot: null }) })
    expect(failure()).toBeNull()
  })

  it('takes nothing from a form, a script, a style, a template or a noscript', async () => {
    await mountAndScan()
    await readLink()
    for (const marker of ['FORM_MARKER', 'APPLY_FORM_MARKER', 'SCRIPT_MARKER', 'INLINE_SCRIPT_MARKER', 'STYLE_MARKER', 'TEMPLATE_MARKER', 'NOSCRIPT_MARKER']) {
      expect(box().value).not.toContain(marker)
    }
  })

  it('a page whose only long text sits in a form gives nothing', async () => {
    fetchLink = vi.fn<FetchLike>(async () => answer(`<html><body><main><form><p>${JD}</p><input name="q"></form></main></body></html>`))
    await mountAndScan()
    typeLink(LINK)
    await waitFor(() => { expect(failure()).toBe(LINK_FAILED) })
    expect(box().value).toBe('')
  })

  it('is cut to the cap', async () => {
    const long = `LONG ${'An analytical engine posting. '.repeat(2_000)}`
    fetchLink = vi.fn<FetchLike>(async () => answer(servedPage(long)))
    await mountAndScan()
    typeLink(LINK)
    await waitFor(() => { expect(line()).toContain('your link') })
    expect(box().value.length).toBe(50_000)
  })

  it('the link survives a reload of the Side panel', async () => {
    const unmount = await mountAndScan()
    await readLink()
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobTextLink: LINK }) })
    unmount()
    await mountAndScan()
    await waitFor(() => { expect(line()).toBe(`${JD.length} characters · your link`) })
    expect(box().value).toBe(JD)
    expect(linkInput().value).toBe(LINK)
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobTextSource: 'link', jobTextLink: LINK }) })
  })
})

describe('a link that gives no posting', () => {
  beforeEach(() => { host.jobText = { text: PAGE_JD, selector: 'main', source: 'heuristic' } })

  async function scannedWithPageText(): Promise<void> {
    await mountAndScan()
    await waitFor(() => { expect(box().value).toBe(PAGE_JD) })
  }

  it('a fetch that throws shows the one message and changes nothing', async () => {
    fetchLink = vi.fn<FetchLike>(async () => { throw new TypeError('Failed to fetch') })
    await scannedWithPageText()
    typeLink(LINK)
    await expectFailureLeavesSession()
  })

  it('a reply that is not ok shows the one message and changes nothing', async () => {
    fetchLink = vi.fn<FetchLike>(async () => answer('Not found', { status: 404 }))
    await scannedWithPageText()
    typeLink(LINK)
    await expectFailureLeavesSession()
  })

  it('a reply under the minimum shows the one message and changes nothing', async () => {
    fetchLink = vi.fn<FetchLike>(async () => answer(servedPage('A short posting.')))
    await scannedWithPageText()
    typeLink(LINK)
    await expectFailureLeavesSession()
  })

  it('a body over 2 MB shows the one message and changes nothing', async () => {
    const padding = `<!-- ${'x'.repeat(POSTING_LINK_MAX_BYTES)} -->`
    fetchLink = vi.fn<FetchLike>(async () => answer(servedPage(JD, padding)))
    await scannedWithPageText()
    typeLink(LINK)
    await expectFailureLeavesSession()
  })

  it('a reply that declares a length over 2 MB shows the one message and changes nothing', async () => {
    fetchLink = vi.fn<FetchLike>(async () => answer(servedPage(), {
      headers: { 'content-type': 'text/html', 'content-length': String(POSTING_LINK_MAX_BYTES + 1) },
    }))
    await scannedWithPageText()
    typeLink(LINK)
    await expectFailureLeavesSession()
  })

  it('a reply that never comes shows the one message once the timeout passes', async () => {
    fetchLink = vi.fn<FetchLike>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    }))
    await scannedWithPageText()
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    typeLink(LINK)
    await waitFor(() => { expect(fetchLink).toHaveBeenCalledTimes(1) })
    expect(failure()).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(POSTING_FETCH_TIMEOUT_MS) })
    vi.useRealTimers()
    await expectFailureLeavesSession()
  })

  it('a failure after a link leaves the earlier link held', async () => {
    await mountAndScan()
    await readLink()
    fetchLink.mockImplementationOnce(async () => { throw new TypeError('Failed to fetch') })
    typeLink('https://careers.example.com/jobs/other')
    await waitFor(() => { expect(failure()).toBe(LINK_FAILED) })
    expect(box().value).toBe(JD)
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: JD, jobTextSource: 'link', jobTextLink: LINK }) })
  })
})

// The read on its own: its time limit, its size cap and its cookies, without
// the panel around it.
describe('readPostingLink', () => {
  it('gives up once the timeout passes, with the body still coming', async () => {
    vi.useFakeTimers()
    let aborted = false
    const stalled = vi.fn<FetchLike>(async (_url, init) => {
      init.signal?.addEventListener('abort', () => { aborted = true })
      // Headers arrive, the body never ends.
      return new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200, headers: { 'content-type': 'text/html' } })
    })
    const read = readPostingLink(LINK, stalled)
    await vi.advanceTimersByTimeAsync(POSTING_FETCH_TIMEOUT_MS - 1)
    expect(await Promise.race([read, Promise.resolve('pending')])).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(await Promise.race([read, Promise.resolve('pending')])).toBeNull()
    expect(aborted).toBe(true)
  })

  it('reads a body of exactly 2 MB, and refuses one byte more', async () => {
    const page = servedPage()
    const pad = (n: number): string => `${page}${' '.repeat(n - new TextEncoder().encode(page).byteLength)}`
    expect(await readPostingLink(LINK, async () => answer(pad(POSTING_LINK_MAX_BYTES)))).toBe(JD)
    expect(await readPostingLink(LINK, async () => answer(pad(POSTING_LINK_MAX_BYTES + 1)))).toBeNull()
  })

  it('sends no cookies', async () => {
    const f = vi.fn<FetchLike>(async () => answer(servedPage()))
    await readPostingLink(LINK, f)
    expect(f.mock.calls[0]![1].credentials).toBe('omit')
  })
})

describe('the held text', () => {
  it('the next Scan uses it and asks the page nothing', async () => {
    await mountAndScan()
    await readLink()
    const asks = jobTextAsks
    await scanAgain()
    expect(jobTextAsks).toBe(asks)
    expect(box().value).toBe(JD)
    expect(line()).toBe(`${JD.length} characters · your link`)
  })

  it('a Scan after a wizard step uses it and asks the page nothing', async () => {
    await mountAndScan()
    await readLink()
    const asks = jobTextAsks
    await nextStep()
    expect(jobTextAsks).toBe(asks)
    expect(box().value).toBe(JD)
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobTextSource: 'link', jobTextLink: LINK }) })
  })

  it('a paste after a link replaces it', async () => {
    await mountAndScan()
    await readLink()
    fireEvent.change(box(), { target: { value: 'Pasted posting' } })
    await waitFor(() => { expect(line()).toBe('14 characters · your paste') })
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: 'Pasted posting', jobTextSource: 'paste', jobTextLink: null }) })
    expect(linkInput().value).toBe('')
  })

  it('a paste while the link is still read is kept when the link answers late (review of PR #112, finding 5)', async () => {
    let serve: (r: Response) => void = () => {}
    fetchLink.mockImplementationOnce(() => new Promise<Response>((resolve) => { serve = resolve }))
    await mountAndScan()
    typeLink(LINK)
    await waitFor(() => { expect(fetchLink).toHaveBeenCalledTimes(1) })
    fireEvent.change(box(), { target: { value: 'Pasted posting' } })
    await waitFor(() => { expect(line()).toBe('14 characters · your paste') })
    await act(async () => { serve(answer(servedPage())) })
    await waitFor(() => { expect(readButton().disabled).toBe(false) })
    expect(box().value).toBe('Pasted posting')
    expect(line()).toBe('14 characters · your paste')
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: 'Pasted posting', jobTextSource: 'paste', jobTextLink: null }) })
  })

  it('a link after a paste replaces the paste', async () => {
    await mountAndScan()
    fireEvent.change(box(), { target: { value: 'Pasted posting' } })
    await waitFor(() => { expect(line()).toBe('14 characters · your paste') })
    await readLink()
    expect(line()).toBe(`${JD.length} characters · your link`)
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: JD, jobTextSource: 'link', jobTextLink: LINK }) })
  })
})

describe('"Not the job description" on a text from a link', () => {
  it('clears the text and the link and asks the page again', async () => {
    host.jobText = { text: PAGE_JD, selector: '#posting', source: 'heuristic' }
    await mountAndScan()
    await readLink()
    expect(rejectButton()).not.toBeNull()
    const asks = jobTextAsks
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(jobTextAsks).toBe(asks + 1) })
    await waitFor(() => { expect(box().value).toBe(PAGE_JD) })
    expect(line()).toBe(`${PAGE_JD.length} characters · a heuristic`)
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: PAGE_JD, jobTextSource: 'heuristic', jobTextLink: null, rejectedJobTextSpots: [] }) })
    expect(linkInput().value).toBe('')
  })

  it('shows nothing found when the page has no text either', async () => {
    await mountAndScan()
    await readLink()
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(line()).toBe('0 characters · nothing found') })
    expect(box().value).toBe('')
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: '', jobTextSource: 'none', jobTextLink: null }) })
  })
})

describe('nothing found', () => {
  it('the line names the link, the paste and the pick', async () => {
    await mountAndScan()
    await waitFor(() => { expect(line()).toBe('0 characters · nothing found') })
    expect(ways()).toMatch(/link/)
    expect(ways()).toMatch(/paste/)
    expect(ways()).toMatch(/pick/)
  })

  it('names them only when nothing was found', async () => {
    await mountAndScan()
    await readLink()
    expect(document.querySelector('[data-jff-jobtext-ways]')).toBeNull()
  })

  it('"Generate with AI" still sends its request, with an empty Job posting text', async () => {
    const PAGE: EnumField[] = [field(0, 'Which versions of Python have you used?', { kind: 'text' })]
    host.fields = PAGE
    host.nothingPending = false
    host.mappingFor = (fs: EnumField[]): Resolution[] => fs.map((f) => resolution(f, { fieldClass: 'personal_fact' }))
    render(<App fetchLink={fetchLink} />)
    await waitFor(() => { expect(host.held).toHaveLength(1) }, { timeout: 8_000 })
    await release(host, (h) => mapped(host, h))
    await waitFor(() => { expect(status()).toBe('done') })
    expect(line()).toBe('0 characters · nothing found')
    fireEvent.click(within(rowOf(PAGE[0]!.label!) as HTMLElement).getByRole('button', { name: 'Generate with AI' }))
    await waitFor(() => { expect(generates).toHaveLength(1) })
    expect(generates[0]!.jobText).toBe('')
  })
})

describe('the Application email', () => {
  const ADDRESSES: FoundAddress[] = [
    { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' } },
  ]

  it('one that waited for the Job posting text starts when a link\'s text arrives', async () => {
    const tab = { id: 7, url: 'https://careers.example.com/jobs/1', title: 'Analyst at Acme' }
    const chrome = (globalThis as unknown as { chrome: Chrome }).chrome
    chrome.tabs.query = async () => [tab]
    chrome.tabs.get = async () => tab
    host.fields = []
    host.addresses = ADDRESSES
    render(<App fetchLink={fetchLink} />)
    await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
    await waitFor(() => { expect(document.querySelector('[data-jff-email-pick="none"]')).not.toBeNull() })
    fireEvent.click(within(document.querySelector('[data-jff-candidate="jobs@example.org"]') as HTMLElement).getByRole('button', { name: 'Use this address' }))
    await waitFor(() => { expect(document.querySelector('[data-jff-email-needs-jobtext]')).not.toBeNull() })
    expect(host.emailDrafts).toHaveLength(0)
    await readLink()
    await waitFor(() => { expect(host.emailDrafts).toHaveLength(1) })
    expect(host.emailDrafts[0]!.jobText).toBe(JD)
  }, 15_000)
})
