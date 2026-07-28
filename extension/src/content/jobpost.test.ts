import { describe, it, expect, beforeEach } from 'vitest'
import { captureJobText, cssPathOf, MIN_JOB_TEXT, startPicker } from './jobpost'

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
