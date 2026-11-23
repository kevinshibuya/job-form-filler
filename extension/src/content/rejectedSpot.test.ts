import { beforeEach, describe, expect, it, vi } from 'vitest'
import { atsModule } from '@jff/shared'
import { captureJobText, readJobText, type PostingReader } from './jobpost'
import { postingFixtureHtml } from './fixtures/real'
import type { FetchLike } from './postingFetch'

/**
 * A rejected spot (spec #98, ticket #102): the page script, given the spots
 * the user said were not the job description, reads past them. The heuristic
 * takes the next candidate that qualifies, and a spot saved for the site that
 * the user rejected is not read.
 */

const long = (marker: string, extra = 0): string => `${marker} ` + 'lorem ipsum dolor sit amet '.repeat(30) + 'x'.repeat(extra)

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('the heuristic and a rejected spot', () => {
  beforeEach(() => {
    // Two candidates that qualify in the same tier: the longer one wins first.
    document.body.innerHTML = `<article id="first">${long('FIRST', 500)}</article><article id="second">${long('SECOND')}</article>`
  })

  it('takes the first candidate when nothing is rejected', () => {
    expect(captureJobText(document, null, [], [])).toMatchObject({ source: 'heuristic', selector: '#first' })
  })

  it('returns the second candidate when the first one\'s spot is rejected', () => {
    const r = captureJobText(document, null, [], ['#first'])
    expect(r).toMatchObject({ source: 'heuristic', selector: '#second' })
    expect(r.text).toContain('SECOND')
    expect(r.text).not.toContain('FIRST')
  })

  it('returns nothing when both spots are rejected', () => {
    expect(captureJobText(document, null, [], ['#first', '#second'])).toEqual({ text: '', selector: null, source: 'none' })
  })

  it('goes on to the next tier when every candidate of a tier is rejected', () => {
    document.body.innerHTML = `<div class="job-description" id="jd">${long('SPECIFIC')}</div><main>${long('GENERIC')}</main>`
    const r = captureJobText(document, null, [], ['#jd'])
    expect(r.source).toBe('heuristic')
    expect(r.text).toContain('GENERIC')
  })

  it('skips a candidate named by a rejected spot written another way', () => {
    // The spot a pick saved and the spot the heuristic names can differ in
    // spelling and still be the same element.
    document.body.innerHTML = `<main><section>${long('FIRST', 500)}</section></main><article>${long('SECOND')}</article>`
    const r = captureJobText(document, null, [], ['main'])
    expect(r.text).toContain('SECOND')
  })

  it('skips a candidate inside a rejected spot, so the same text is not read again', () => {
    // Reject a `main`, and an `article` inside it holds part of the same text.
    document.body.innerHTML = `<main id="m"><article>${long('INNER', 500)}</article></main><section role="main">${long('OTHER')}</section>`
    const r = captureJobText(document, null, [], ['#m'])
    expect(r.text).toContain('OTHER')
    expect(r.text).not.toContain('INNER')
  })

  it('measures a candidate that holds a rejected spot without it', () => {
    // Reject the description inside a `main`, and the `main` around it holds
    // the same text: what is left of it is too short to count.
    document.body.innerHTML = `<main><div class="job-description" id="jd">${long('REJECTED')}</div><p>Apply below.</p></main>`
    expect(captureJobText(document, null, [], ['#jd'])).toEqual({ text: '', selector: null, source: 'none' })
  })

  it('reads what is left of a candidate around a rejected spot when it still qualifies', () => {
    document.body.innerHTML = `<main><div class="job-description" id="jd">${long('REJECTED')}</div><section>${long('KEPT')}</section></main>`
    const r = captureJobText(document, null, [], ['#jd'])
    expect(r.text).toContain('KEPT')
    expect(r.text).not.toContain('REJECTED')
  })

  it('a rejected spot that names no element, or is not a selector, rejects nothing', () => {
    expect(captureJobText(document, null, [], ['#gone', '[[[not a selector'])).toMatchObject({ selector: '#first' })
  })
})

describe('a spot saved for the site and a rejected spot', () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="jd">${long('PICKED')}</div><main>${long('HEURISTIC')}</main>`
  })

  it('is read when it is not rejected', () => {
    expect(captureJobText(document, '#jd', [], [])).toMatchObject({ source: 'learned', selector: '#jd' })
  })

  it('is not read when it is in the rejected list, and the heuristic answers instead', () => {
    const r = captureJobText(document, '#jd', [], ['#jd'])
    expect(r.source).toBe('heuristic')
    expect(r.text).toContain('HEURISTIC')
    expect(r.text).not.toContain('PICKED')
  })

  it('is not read when a rejected spot names the same element', () => {
    expect(captureJobText(document, 'body > div', [], ['#jd']).source).toBe('heuristic')
  })

  it('gives nothing when the saved spot and the heuristic\'s spot are both rejected', () => {
    expect(captureJobText(document, '#jd', [], ['#jd', 'main']).source).toBe('none')
  })
})

describe('the page\'s order with a rejected spot', () => {
  const APPLY = 'https://jobs.lever.co/acme/0000-posting/apply'
  const reader = (fetch: FetchLike): PostingReader => ({ module: atsModule('lever'), formPageUrl: APPLY, fetch })

  it('the ATS module still answers first: it has no spot to reject', async () => {
    document.body.innerHTML = `<div id="jd">${long('PICKED')}</div>`
    const fetch = vi.fn<FetchLike>(async () => new Response(postingFixtureHtml('lever-posting'), { status: 200 }))
    expect(await readJobText(document, '#jd', reader(fetch), [], ['#jd'])).toMatchObject({ source: 'ats', selector: null })
  })

  it('a posting page that cannot be read hands over past the rejected pick to the heuristic', async () => {
    document.body.innerHTML = `<div id="jd">${long('PICKED')}</div><main>${long('HEURISTIC')}</main>`
    const fetch = vi.fn<FetchLike>(async () => { throw new TypeError('Failed to fetch') })
    const r = await readJobText(document, '#jd', reader(fetch), [], ['#jd'])
    expect(r.source).toBe('heuristic')
    expect(r.text).toContain('HEURISTIC')
  })
})
