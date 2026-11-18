import { beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_COMPANY, postingRoot } from '@jff/shared'
import { MIN_JOB_TEXT, captureJobText } from './jobpost'
import { POSTING_FIXTURES, REAL_FIXTURES, loadPostingFixture } from './fixtures/real'

// The Lever posting fixture: a public Lever posting page cut with
// `sanitize-capture.mjs --posting`. The rule that reads Lever's posting page is
// written from it (ADR 0007), so it must hold the posting and pass the minimum.

function text(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

describe('the Lever posting fixture', () => {
  beforeEach(() => loadPostingFixture('lever-posting'))

  it('is read by name, apart from the form fixtures', () => {
    expect(POSTING_FIXTURES).toContain('lever-posting')
    expect(REAL_FIXTURES).not.toContain('lever-posting')
  })

  it('holds at least the minimum of text inside the posting\'s element', () => {
    const posting = postingRoot(document)
    expect(posting).not.toBeNull()
    expect(text(posting).length).toBeGreaterThanOrEqual(MIN_JOB_TEXT)
  })

  it('gives the page script\'s heuristic a Job posting text it takes', () => {
    const found = captureJobText(document, null)
    expect(found.source).toBe('heuristic')
    expect(found.text.length).toBeGreaterThanOrEqual(MIN_JOB_TEXT)
  })

  it('holds no address, no Lever posting id and names the Company generically', () => {
    const html = document.documentElement.outerHTML
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
    expect(html).not.toMatch(/lever\.co\//i)
    expect(document.title).toContain(FIXTURE_COMPANY)
  })

  it('holds no form and no Control', () => {
    expect(document.querySelector('form, input, select, textarea')).toBeNull()
  })
})
