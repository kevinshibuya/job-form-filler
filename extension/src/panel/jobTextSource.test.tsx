import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import { capForStorage, newSession, type Session } from './sessions'
import { field, installHeldMappingHost, status } from './testing/heldMapping'
import { postingReaderFor, readJobText } from '../content/jobpost'
import type { FetchLike } from '../content/postingFetch'
import { postingFixtureHtml } from '../content/fixtures/real'

/**
 * Where the Job posting text came from (spec #41, ticket #50), the Side panel
 * rendered with a fake Native host. Under the job description box one line
 * says how many characters the Session holds and where they came from, and
 * "Not the job description" throws a picked or guessed text away.
 */

const host = installHeldMappingHost()

const PAGE_URL = 'https://jobs.example.com/apply'
const HOSTNAME = 'jobs.example.com'

/** A posting long enough for the 400-character minimum. */
const JD = `JOB POSTING ${'Build reliable systems with a small team. '.repeat(12)}`.trim()

type JobTextReply = { text: string; selector: string | null; source: string }
type Chrome = { runtime: { sendMessage: (msg: unknown) => Promise<unknown> }; tabs: { query: unknown; get: unknown } }

/** What the page's job text reply holds, per Scan. */
let pageJobText: JobTextReply
/** When set, the page answers the job text request with this instead, given
 *  the saved spot and the spots the Session rejected. */
let readPage: ((selector: string | null, rejected: string[]) => Promise<JobTextReply>) | null
/** The spot `selector.get` answers with. */
let savedSpot: string | null
/** Every host request about the job text, in order, as method and params. */
let spotRequests: { method: string; params: Record<string, unknown> }[]
/** How many times a Scan asked the page for its job text. */
let jobTextAsks: number
/** The `capture.save` requests, as their params. */
let captures: Record<string, unknown>[]
/** What the picker hands back when the user clicks. */
let picked: { selector: string; text: string }

beforeEach(() => {
  pageJobText = { text: '', selector: null, source: 'none' }
  readPage = null
  savedSpot = null
  spotRequests = []
  jobTextAsks = 0
  captures = []
  picked = { selector: '#jd', text: JD }
  host.fields = [field(0, 'Email'), field(1, 'Why us?')]
  host.nothingPending = true
  const chrome = (globalThis as unknown as { chrome: Chrome }).chrome
  const tab = { id: 7, url: PAGE_URL, title: 'Engineer at Example' }
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
  const relay = chrome.runtime.sendMessage
  chrome.runtime.sendMessage = async (msg: unknown) => {
    const m = msg as { kind?: string; frameId?: number; message?: { type?: string } }
    if (m.kind === 'toContent' && m.message?.type === 'JFF_JOBTEXT') {
      jobTextAsks++
      const ask = m.message as { selector: string | null; rejected?: string[] }
      const jobText = readPage === null ? pageJobText : await readPage(ask.selector, ask.rejected ?? [])
      return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText } }], failures: [] }
    }
    if (m.kind === 'toContent' && m.message?.type === 'JFF_PICK') {
      return { ok: true, replies: [{ frameId: 0, payload: { ok: true, pick: picked } }], failures: [] }
    }
    if (m.kind === 'toContent' && m.message?.type === 'JFF_CAPTURE') {
      return { ok: true, replies: [{ frameId: 0, url: null, payload: { ok: true, capture: { html: '<html><body><form></form></body></html>', cut: false } } }], failures: [] }
    }
    return relay(msg)
  }
  const bridge = window.__jffHostBridge!
  window.__jffHostBridge = async (req) => {
    const params = req.params as Record<string, unknown>
    if (req.method === 'selector.get') {
      spotRequests.push({ method: req.method, params })
      return { requestId: req.requestId, ok: true, result: { selector: savedSpot } }
    }
    if (req.method === 'selector.save' || req.method === 'selector.clear') {
      spotRequests.push({ method: req.method, params })
      const had = savedSpot !== null
      savedSpot = req.method === 'selector.save' ? String(params.selector) : null
      return { requestId: req.requestId, ok: true, result: req.method === 'selector.save' ? { selector: savedSpot } : { cleared: had } }
    }
    if (req.method === 'capture.save') {
      captures.push(params)
      return { requestId: req.requestId, ok: true, result: { path: '/home/ada/.job-form-filler/captures/c.json' } }
    }
    return bridge(req)
  }
})

const line = (): string => document.querySelector('[data-jff-jobtext-source]')?.textContent ?? ''
const box = (): HTMLTextAreaElement => document.querySelector('[data-jff-paste] textarea') as HTMLTextAreaElement
const rejectButton = (): HTMLElement | null => screen.queryByRole('button', { name: 'Not the job description' })
const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined
const methods = (): string[] => spotRequests.map((r) => r.method)

async function mountAndScan(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe('done') }, { timeout: 8_000 })
}

async function scanAgain(): Promise<void> {
  const scans = host.scans
  fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
  await waitFor(() => { expect(host.scans).toBeGreaterThan(scans) })
  await waitFor(() => { expect(status()).toBe('done') })
}

describe('the job text source line', () => {
  it('a Scan with pasted text uses it, asks the page for nothing, and reads "your paste"', async () => {
    await mountAndScan()
    const asked = jobTextAsks
    fireEvent.change(box(), { target: { value: 'Pasted posting' } })
    await waitFor(() => { expect(line()).toBe('14 characters · your paste') })
    await scanAgain()
    expect(jobTextAsks).toBe(asked)
    expect(box().value).toBe('Pasted posting')
    expect(line()).toBe('14 characters · your paste')
  })

  it('a heuristic\'s text saves no spot, reads "a heuristic", and still does after a second Scan', async () => {
    pageJobText = { text: JD, selector: 'main', source: 'heuristic' }
    await mountAndScan()
    await waitFor(() => { expect(line()).toBe(`${JD.length} characters · a heuristic`) })
    expect(methods()).not.toContain('selector.save')
    await scanAgain()
    expect(line()).toBe(`${JD.length} characters · a heuristic`)
    expect(methods()).not.toContain('selector.save')
  })

  it('typing in the box after a heuristic makes it "your paste", and the next Scan keeps it', async () => {
    pageJobText = { text: JD, selector: 'main', source: 'heuristic' }
    await mountAndScan()
    await waitFor(() => { expect(line()).toContain('a heuristic') })
    fireEvent.change(box(), { target: { value: `${JD} Remote.` } })
    await waitFor(() => { expect(line()).toBe(`${JD.length + 8} characters · your paste`) })
    await scanAgain()
    expect(line()).toBe(`${JD.length + 8} characters · your paste`)
    await waitFor(() => { expect(sessionRow()?.jobTextSource).toBe('paste') })
  })

  it('a site with a saved spot reads "your pick"', async () => {
    savedSpot = '#jd'
    pageJobText = { text: JD, selector: '#jd', source: 'learned' }
    await mountAndScan()
    await waitFor(() => { expect(line()).toBe(`${JD.length} characters · your pick`) })
  })

  it('the ATS module\'s text reads with the ATS\'s name', async () => {
    const chrome = (globalThis as unknown as { chrome: Chrome }).chrome
    const tab = { id: 7, url: 'https://jobs.lever.co/acme/123/apply', title: 'Apply' }
    chrome.tabs.query = async () => [tab]
    chrome.tabs.get = async () => tab
    host.frameUrl = tab.url
    pageJobText = { text: JD, selector: null, source: 'ats' }
    await mountAndScan()
    await waitFor(() => { expect(line()).toBe(`${JD.length} characters · the Lever posting page`) })
  })

  // Spec #41, #52: the page script reads the posting's page, with a stubbed fetch.
  describe('on a Lever apply page', () => {
    const APPLY = 'https://jobs.lever.co/acme/0000-posting/apply'
    let fetch: ReturnType<typeof vi.fn<FetchLike>>

    beforeEach(() => {
      const chrome = (globalThis as unknown as { chrome: Chrome }).chrome
      const tab = { id: 7, url: APPLY, title: 'Apply' }
      chrome.tabs.query = async () => [tab]
      chrome.tabs.get = async () => tab
      host.frameUrl = APPLY
      fetch = vi.fn<FetchLike>(async () => new Response(postingFixtureHtml('lever-posting'), { status: 200 }))
      readPage = (selector, rejected) => readJobText(document, selector, postingReaderFor(APPLY, fetch), [], rejected)
    })

    it('the text comes from the posting\'s page and the line reads "the Lever posting page"', async () => {
      await mountAndScan()
      await waitFor(() => { expect(line()).toMatch(/^\d+ characters · the Lever posting page$/) })
      expect(box().value).toContain('Placeholder text where the Job posting described the role.')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' })
      expect(rejectButton()).toBeNull()
    })

    // #59 item 3: today's behaviour stays. A read that failed is tried again.
    it('a posting-page read that failed on one Scan is attempted again on the next', async () => {
      fetch.mockImplementationOnce(async () => { throw new TypeError('Failed to fetch') })
      await mountAndScan()
      await waitFor(() => { expect(line()).toBe('0 characters · nothing found') })
      expect(fetch).toHaveBeenCalledTimes(1)
      await scanAgain()
      await waitFor(() => { expect(line()).toMatch(/^\d+ characters · the Lever posting page$/) })
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('a second Scan in the Session makes no second fetch', async () => {
      await mountAndScan()
      await waitFor(() => { expect(line()).toContain('the Lever posting page') })
      await scanAgain()
      expect(line()).toContain('the Lever posting page')
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('a paste still wins over it, and the next Scan makes no fetch', async () => {
      await mountAndScan()
      await waitFor(() => { expect(line()).toContain('the Lever posting page') })
      fireEvent.change(box(), { target: { value: 'Pasted posting' } })
      await waitFor(() => { expect(line()).toBe('14 characters · your paste') })
      await scanAgain()
      expect(line()).toBe('14 characters · your paste')
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })

  it('a Scan that finds no text reads "nothing found" with a count of 0', async () => {
    await mountAndScan()
    await waitFor(() => { expect(line()).toBe('0 characters · nothing found') })
  })

  it('a Session saved before the source was kept loads with no source and shows the count', async () => {
    const older = { ...newSession(7, PAGE_URL), jobText: 'Older text' } as Partial<Session>
    delete older.jobTextSource
    host.storage['jff:session:7'] = capForStorage(older as Session)
    await mountAndScan()
    await waitFor(() => { expect(box().value).toBe('Older text') })
    expect(line()).toBe('10 characters')
    expect(rejectButton()).toBeNull()
  })
})

describe('picking the job description', () => {
  it('still saves the picked spot for the site, and reads "your pick"', async () => {
    await mountAndScan()
    fireEvent.click(screen.getByRole('button', { name: 'Pick job description' }))
    await waitFor(() => { expect(line()).toBe(`${JD.length} characters · your pick`) })
    await waitFor(() => { expect(spotRequests.find((r) => r.method === 'selector.save')?.params).toEqual({ hostname: HOSTNAME, purpose: 'job_description', selector: '#jd' }) })
  })

  it('refuses a picked spot shorter than the minimum, and saves nothing', async () => {
    picked = { selector: '#cookie', text: 'We use cookies.' }
    await mountAndScan()
    fireEvent.click(screen.getByRole('button', { name: 'Pick job description' }))
    await waitFor(() => { expect(screen.getByText(/at least 400 characters/)).toBeTruthy() })
    expect(box().value).toBe('')
    expect(methods()).not.toContain('selector.save')
  })
})

describe('"Not the job description"', () => {
  it('is offered for a heuristic and for a pick', async () => {
    pageJobText = { text: JD, selector: 'main', source: 'heuristic' }
    await mountAndScan()
    await waitFor(() => { expect(rejectButton()).not.toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'Pick job description' }))
    await waitFor(() => { expect(line()).toContain('your pick') })
    expect(rejectButton()).not.toBeNull()
  })

  it('is not offered for a paste or for nothing found', async () => {
    await mountAndScan()
    await waitFor(() => { expect(line()).toContain('nothing found') })
    expect(rejectButton()).toBeNull()
    fireEvent.change(box(), { target: { value: 'Pasted posting' } })
    await waitFor(() => { expect(line()).toContain('your paste') })
    expect(rejectButton()).toBeNull()
  })

  it('empties the Session\'s text, sets nothing found, and the host forgets the spot', async () => {
    savedSpot = '#jd'
    // The page holds no other text: once '#jd' is rejected it answers with none.
    readPage = async (selector, rejected) => (selector === '#jd' && !rejected.includes('#jd')
      ? { text: JD, selector: '#jd', source: 'learned' }
      : { text: '', selector: null, source: 'none' })
    await mountAndScan()
    await waitFor(() => { expect(rejectButton()).not.toBeNull() })
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(line()).toBe('0 characters · nothing found') })
    expect(box().value).toBe('')
    expect(rejectButton()).toBeNull()
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: '', jobTextSource: 'none', rejectedJobTextSpots: ['#jd'] }) })
    await waitFor(() => { expect(spotRequests.find((r) => r.method === 'selector.clear')?.params).toEqual({ hostname: HOSTNAME, purpose: 'job_description' }) })
    expect(savedSpot).toBeNull()
  })
})

describe('a Capture', () => {
  it('carries the source of the Scan before it', async () => {
    pageJobText = { text: JD, selector: 'main', source: 'heuristic' }
    await mountAndScan()
    await waitFor(() => { expect(line()).toContain('a heuristic') })
    fireEvent.click(screen.getByRole('button', { name: 'Save a capture' }))
    await waitFor(() => { expect(captures).toHaveLength(1) })
    expect(captures[0]!.jobTextSource).toBe('heuristic')
  })
})
