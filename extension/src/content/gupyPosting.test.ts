import { describe, expect, it, vi } from 'vitest'
import { FIXTURE_COMPANY, GENERIC_MODULE, atsModule, findAts, postingRoot } from '@jff/shared'
import { MIN_JOB_TEXT, captureJobText, postingReaderFor, readJobText } from './jobpost'
import type { FetchLike } from './postingFetch'
import {
  POSTING_FIXTURES, REAL_FIXTURES, STEP_FIXTURES, loadPostingFixture, loadStepFixture, postingFixtureHtml,
} from './fixtures/real'

// #108: on Gupy, does a step page of an application give a route to the Job
// posting's own page? It does not (docs/research/gupy-posting-route.md): the
// step page's address carries an application id and a step id, not the job id;
// the page holds no link to the posting; and its served page is an empty app
// shell with no page data. So Gupy gets no ATS module, and the link box is
// Gupy's answer. The fixtures: the step page cut with `sanitize-capture.mjs
// --page`, the posting page with `--posting`.

const STEP = 'https://acme.gupy.io/candidates/applications/90001/steps/90002/curriculum'

function text(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

describe('the Gupy step fixture', () => {
  it('is read by name, apart from the form and posting fixtures', () => {
    expect(STEP_FIXTURES).toContain('gupy-step')
    expect(REAL_FIXTURES).not.toContain('gupy-step')
    expect(POSTING_FIXTURES).not.toContain('gupy-step')
  })

  it('is the step page before its form opens: no form and no Control', () => {
    loadStepFixture('gupy-step')
    expect(document.querySelector('form, input, select, textarea')).toBeNull()
    expect(text(document.querySelector('h1'))).toBe('Olá Ada, vamos continuar sua candidatura?')
  })

  it('holds no address, no id and names the Company generically', () => {
    loadStepFixture('gupy-step')
    const html = document.documentElement.outerHTML
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/applications\/\d|steps\/\d|jobs\/\d/)
    expect(html).not.toContain('<!--')
    expect(document.title).toBe(`Page at ${FIXTURE_COMPANY}`)
    expect(text(document.body)).toContain(`na empresa ${FIXTURE_COMPANY}.`)
  })

  it('holds no link to the posting\'s page', () => {
    loadStepFixture('gupy-step')
    for (const a of Array.from(document.querySelectorAll('a'))) expect(a.getAttribute('href') ?? '').toBe('')
  })
})

describe('on a Gupy step page the tool reads no Job posting text: the route to the posting is none', () => {
  it('gives Gupy no ATS module, so no Job posting page rule', () => {
    expect(findAts(new URL(STEP).hostname)?.id).toBe('gupy')
    expect(atsModule('gupy')).toBe(GENERIC_MODULE)
    expect(atsModule('gupy').jobText).toBeUndefined()
  })

  it('reads nothing from the step fixture and fetches no page', async () => {
    loadStepFixture('gupy-step')
    const fetch = vi.fn<FetchLike>(async () => new Response(postingFixtureHtml('gupy-posting')))
    const reader = postingReaderFor(STEP, fetch)
    expect(reader.module).toBe(GENERIC_MODULE)

    const found = await readJobText(document, null, reader, [])
    expect(found).toEqual({ text: '', selector: null, source: 'none' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('the Gupy posting fixture', () => {
  it('is read by name, apart from the form fixtures', () => {
    expect(POSTING_FIXTURES).toContain('gupy-posting')
    expect(REAL_FIXTURES).not.toContain('gupy-posting')
  })

  it('serves its text without scripts: the file as a server sends it holds the posting', () => {
    const doc = new DOMParser().parseFromString(postingFixtureHtml('gupy-posting'), 'text/html')
    expect(text(postingRoot(doc)).length).toBeGreaterThanOrEqual(MIN_JOB_TEXT)
  })

  it('gives the page script\'s heuristic a Job posting text it takes', () => {
    loadPostingFixture('gupy-posting')
    const found = captureJobText(document, null, [])
    expect(found.source).toBe('heuristic')
    expect(found.text.length).toBeGreaterThanOrEqual(MIN_JOB_TEXT)
  })

  it('holds no address, no id and names the Company generically', () => {
    loadPostingFixture('gupy-posting')
    const html = document.documentElement.outerHTML
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/jobs\/\d|\d{7,}/)
    expect(document.title).toBe(`Job posting at ${FIXTURE_COMPANY}`)
  })
})
