import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import type { Session } from './sessions'
import { field, installHeldMappingHost, status } from './testing/heldMapping'

/**
 * "Not the job description" reads the page again (spec #98, ticket #102), the
 * Side panel rendered with a fake Native host. The click throws the text away,
 * rejects its spot for the rest of the Session, has the host forget the spot
 * saved for the site, and asks the page again at once with the rejected spots
 * left out.
 */

const host = installHeldMappingHost()

const PAGE_URL = 'https://jobs.example.com/apply'
const HOSTNAME = 'jobs.example.com'

const posting = (marker: string): string => `${marker} ${'Build reliable systems with a small team. '.repeat(12)}`.trim()
const FORM_TEXT = posting('QUESTIONS')
const JD = posting('JOB POSTING')
const PICKED = posting('PICKED POSTING')

type JobTextReply = { text: string; selector: string | null; source: string }
type JobTextAsk = { type: 'JFF_JOBTEXT'; selector: string | null; rejected?: string[] }
type Chrome = { runtime: { sendMessage: (msg: unknown) => Promise<unknown> }; tabs: { query: unknown; get: unknown } }

/** The page's heuristic candidates, in the order the page script takes them. */
let candidates: { spot: string; text: string }[]
/** The text at the spot saved for the site, when one is saved. */
let atSavedSpot: string
/** The spot `selector.get` answers with. */
let savedSpot: string | null
/** Every job text request the page received. */
let asks: JobTextAsk[]
/** The host's spot requests and the page's job text requests, in order. */
let events: string[]
/** When set, the page holds its answer until the test releases it. */
let hold: { release: () => void; waiting: Promise<void> } | null
/** What the picker hands back when the user clicks. */
let picked: { selector: string; text: string }

/** The page script's order, faked: the saved spot unless it is rejected, then
 *  the first candidate whose spot is not rejected. */
function pageAnswers(ask: JobTextAsk): JobTextReply {
  const rejected = ask.rejected ?? []
  if (ask.selector !== null && !rejected.includes(ask.selector)) return { text: atSavedSpot, selector: ask.selector, source: 'learned' }
  const next = candidates.find((c) => !rejected.includes(c.spot))
  return next === undefined ? { text: '', selector: null, source: 'none' } : { text: next.text, selector: next.spot, source: 'heuristic' }
}

function holdThePage(): () => void {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  hold = { release, waiting }
  return () => { hold = null; release() }
}

beforeEach(() => {
  candidates = [{ spot: 'body > main', text: FORM_TEXT }, { spot: '#posting', text: JD }]
  atSavedSpot = PICKED
  savedSpot = null
  asks = []
  events = []
  hold = null
  picked = { selector: '#picked', text: PICKED }
  host.fields = [field(0, 'Email'), field(1, 'Why us?')]
  host.nothingPending = true
  const chrome = (globalThis as unknown as { chrome: Chrome }).chrome
  const tab = { id: 7, url: PAGE_URL, title: 'Engineer at Example' }
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
  const relay = chrome.runtime.sendMessage
  chrome.runtime.sendMessage = async (msg: unknown) => {
    const m = msg as { kind?: string; message?: { type?: string } }
    if (m.kind === 'toContent' && m.message?.type === 'JFF_JOBTEXT') {
      const ask = m.message as JobTextAsk
      asks.push(ask)
      events.push('JFF_JOBTEXT')
      if (hold !== null) await hold.waiting
      return { ok: true, replies: [{ frameId: 0, payload: { ok: true, jobText: pageAnswers(ask) } }], failures: [] }
    }
    if (m.kind === 'toContent' && m.message?.type === 'JFF_PICK') {
      return { ok: true, replies: [{ frameId: 0, payload: { ok: true, pick: picked } }], failures: [] }
    }
    return relay(msg)
  }
  const bridge = window.__jffHostBridge!
  window.__jffHostBridge = async (req) => {
    const params = req.params as Record<string, unknown>
    if (req.method === 'selector.get') {
      events.push('selector.get')
      return { requestId: req.requestId, ok: true, result: { selector: savedSpot } }
    }
    if (req.method === 'selector.save' || req.method === 'selector.clear') {
      events.push(req.method)
      const had = savedSpot !== null
      savedSpot = req.method === 'selector.save' ? String(params.selector) : null
      return { requestId: req.requestId, ok: true, result: req.method === 'selector.save' ? { selector: savedSpot } : { cleared: had } }
    }
    return bridge(req)
  }
})

const line = (): string => document.querySelector('[data-jff-jobtext-source]')?.textContent ?? ''
const box = (): HTMLTextAreaElement => document.querySelector('[data-jff-paste] textarea') as HTMLTextAreaElement
const rejectButton = (): HTMLButtonElement | null => screen.queryByRole('button', { name: 'Not the job description' })
const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined
const lastAsk = (): JobTextAsk => asks[asks.length - 1]!

async function mountAndScan(): Promise<() => void> {
  const { unmount } = render(<App />)
  await waitFor(() => { expect(status()).toBe('done') }, { timeout: 8_000 })
  return unmount
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

describe('"Not the job description" reads the page again', () => {
  it('a click asks the page again with the rejected spot, without a Scan', async () => {
    await mountAndScan()
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
    const scans = host.scans
    const before = asks.length
    expect(lastAsk().rejected ?? []).toEqual([])
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(asks.length).toBe(before + 1) })
    expect(lastAsk().rejected).toEqual(['body > main'])
    expect(host.scans).toBe(scans)
  })

  it('the box shows the text the page answered with, and its source', async () => {
    await mountAndScan()
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(box().value).toBe(JD) })
    expect(line()).toBe(`${JD.length} characters · a heuristic`)
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: JD, jobTextSource: 'heuristic', jobTextSpot: '#posting', rejectedJobTextSpots: ['body > main'] }) })
  })

  it('shows "nothing found" when the page answers with no text', async () => {
    candidates = [{ spot: 'body > main', text: FORM_TEXT }]
    await mountAndScan()
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
    const before = asks.length
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(asks.length).toBe(before + 1) })
    await waitFor(() => { expect(line()).toBe('0 characters · nothing found') })
    expect(box().value).toBe('')
    expect(rejectButton()).toBeNull()
  })

  it('a second click rejects the second text too, and both spots travel', async () => {
    await mountAndScan()
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(box().value).toBe(JD) })
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(line()).toBe('0 characters · nothing found') })
    expect(lastAsk().rejected).toEqual(['body > main', '#posting'])
  })

  it('the host forgets the spot saved for the site before the page is asked again', async () => {
    savedSpot = '#picked'
    await mountAndScan()
    await waitFor(() => { expect(line()).toContain('your pick') })
    events = []
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
    expect(events.indexOf('selector.clear')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('selector.clear')).toBeLessThan(events.indexOf('JFF_JOBTEXT'))
    expect(savedSpot).toBeNull()
    expect(lastAsk().rejected).toEqual(['#picked'])
  })

  it('the button is disabled while the page is being asked', async () => {
    await mountAndScan()
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
    const release = holdThePage()
    const before = asks.length
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(asks.length).toBe(before + 1) })
    expect(rejectButton()?.disabled).toBe(true)
    release()
    await waitFor(() => { expect(box().value).toBe(JD) })
    expect(rejectButton()?.disabled).toBe(false)
  })

  it('a text the user pasted while the page was being asked is kept, and the page\'s answer is dropped', async () => {
    await mountAndScan()
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
    const release = holdThePage()
    const before = asks.length
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(asks.length).toBe(before + 1) })
    fireEvent.change(box(), { target: { value: 'Pasted posting' } })
    await waitFor(() => { expect(line()).toBe('14 characters · your paste') })
    release()
    await waitFor(() => { expect(rejectButton()).toBeNull() })
    await new Promise((r) => setTimeout(r, 50))
    expect(box().value).toBe('Pasted posting')
    expect(line()).toBe('14 characters · your paste')
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobText: 'Pasted posting', jobTextSource: 'paste', jobTextSpot: null }) })
  })
})

describe('a text keeps its spot', () => {
  it('a pick\'s spot is rejected by a click after a reload of the Side panel', async () => {
    candidates = []
    const unmount = await mountAndScan()
    fireEvent.click(screen.getByRole('button', { name: 'Pick job description' }))
    await waitFor(() => { expect(line()).toContain('your pick') })
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobTextSource: 'pick', jobTextSpot: '#picked' }) })
    unmount()
    await mountAndScan()
    await waitFor(() => { expect(line()).toContain('your pick') })
    const before = asks.length
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(asks.length).toBe(before + 1) })
    expect(lastAsk().rejected).toEqual(['#picked'])
  })

  it('a heuristic\'s spot is rejected by a click after a reload of the Side panel', async () => {
    const unmount = await mountAndScan()
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobTextSource: 'heuristic', jobTextSpot: 'body > main' }) })
    unmount()
    await mountAndScan()
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(box().value).toBe(JD) })
    expect(lastAsk().rejected).toEqual(['body > main'])
  })

  it('a paste keeps no spot', async () => {
    await mountAndScan()
    fireEvent.change(box(), { target: { value: 'Pasted posting' } })
    await waitFor(() => { expect(sessionRow()).toMatchObject({ jobTextSource: 'paste', jobTextSpot: null }) })
  })
})

describe('how long a rejection lasts', () => {
  /** Rejects the only candidate, so the Session holds no text and the next
   *  Scan asks the page again. */
  async function rejectTheOnlyText(): Promise<void> {
    candidates = [{ spot: 'body > main', text: FORM_TEXT }]
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(line()).toBe('0 characters · nothing found') })
  }

  it('the next Scan carries the same rejected spots', async () => {
    await mountAndScan()
    await rejectTheOnlyText()
    const before = asks.length
    await scanAgain()
    expect(asks.length).toBe(before + 1)
    expect(lastAsk().rejected).toEqual(['body > main'])
    expect(line()).toBe('0 characters · nothing found')
  })

  it('a Scan after a wizard step on the same site carries them too', async () => {
    await mountAndScan()
    await rejectTheOnlyText()
    const before = asks.length
    await nextStep()
    await waitFor(() => { expect(asks.length).toBeGreaterThan(before) })
    expect(lastAsk().rejected).toEqual(['body > main'])
  })

  it('they survive a reload of the Side panel', async () => {
    const unmount = await mountAndScan()
    await rejectTheOnlyText()
    await waitFor(() => { expect(sessionRow()?.rejectedJobTextSpots).toEqual(['body > main']) })
    unmount()
    const before = asks.length
    await mountAndScan()
    await waitFor(() => { expect(asks.length).toBeGreaterThan(before) })
    expect(lastAsk().rejected).toEqual(['body > main'])
  })

  it('they are gone in a new Session, and nothing is kept for the site', async () => {
    const unmount = await mountAndScan()
    await rejectTheOnlyText()
    await waitFor(() => { expect(sessionRow()?.rejectedJobTextSpots).toEqual(['body > main']) })
    unmount()
    delete host.storage['jff:session:7']
    const before = asks.length
    await mountAndScan()
    await waitFor(() => { expect(asks.length).toBeGreaterThan(before) })
    expect(lastAsk().rejected).toEqual([])
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
  })
})

describe('the request names the site', () => {
  it('the host is asked for the spot saved for the site the click happened on', async () => {
    const methods: { method: string; params: unknown }[] = []
    const bridge = window.__jffHostBridge!
    window.__jffHostBridge = async (req) => {
      if (req.method === 'selector.clear') methods.push({ method: req.method, params: req.params })
      return bridge(req)
    }
    await mountAndScan()
    await waitFor(() => { expect(box().value).toBe(FORM_TEXT) })
    fireEvent.click(rejectButton()!)
    await waitFor(() => { expect(methods).toHaveLength(1) })
    expect(methods[0]!.params).toEqual({ hostname: HOSTNAME, purpose: 'job_description' })
  })
})
