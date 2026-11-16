import { describe, expect, it } from 'vitest'
import { canonicalUrl } from './canonicalUrl.js'

describe('canonicalUrl (A1)', () => {
  it('ashby: the identity param survives; tracking params, scheme and www. drop; host lowercases', () => {
    expect(canonicalUrl('https://www.TRMLabs.com/careers/?ashby_jid=6edf242b&utm_source=x&gh_src=abc'))
      .toBe('trmlabs.com/careers?ashby_jid=6edf242b')
  })

  it('greenhouse: path identity survives; gh_src/ref/source and the fragment drop', () => {
    expect(canonicalUrl('https://job-boards.greenhouse.io/deliveryassociates/jobs/8517393002?gh_src=abc&ref=li&source=tw#app'))
      .toBe('job-boards.greenhouse.io/deliveryassociates/jobs/8517393002')
  })

  it('keeps jobId and unknown params, sorted for stability', () => {
    expect(canonicalUrl('https://x.com/a?z=1&jobId=9&a=2')).toBe('x.com/a?a=2&jobId=9&z=1')
  })

  it('scheme, www., trailing slash, fragment and param order all collide on ONE canonical form', () => {
    expect(canonicalUrl('https://X.com/jobs/1/?utm_campaign=a#top')).toBe(canonicalUrl('http://www.x.com/jobs/1'))
  })

  it('path case is preserved (only the host lowercases); a bare root path drops', () => {
    expect(canonicalUrl('https://Jobs.Acme.COM/Apply/')).toBe('jobs.acme.com/Apply')
    expect(canonicalUrl('https://acme.com/')).toBe('acme.com')
  })

  it('an unparseable url passes through trimmed', () => {
    expect(canonicalUrl('  not a url ')).toBe('not a url')
  })

  it('ashby ATS host: ref/source drop there too', () => {
    expect(canonicalUrl('https://jobs.ashbyhq.com/acme/6edf242b?ref=li&source=tw'))
      .toBe('jobs.ashbyhq.com/acme/6edf242b')
  })

  it('unknown host: two jobs differing only by ref stay APART (never collide on one row)', () => {
    expect(canonicalUrl('https://x.com/j/1?ref=a')).not.toBe(canonicalUrl('https://x.com/j/1?ref=b'))
    expect(canonicalUrl('https://x.com/j/1?ref=a')).toBe('x.com/j/1?ref=a')
  })

  it('unknown host: two jobs differing only by source stay APART', () => {
    expect(canonicalUrl('https://x.com/j/1?source=a')).not.toBe(canonicalUrl('https://x.com/j/1?source=b'))
    expect(canonicalUrl('https://x.com/j/1?source=b')).toBe('x.com/j/1?source=b')
  })

  it('utm_*/gh_src stay GLOBAL: they drop even on an unknown host', () => {
    expect(canonicalUrl('https://x.com/j/1?utm_source=a&utm_campaign=b&gh_src=c')).toBe('x.com/j/1')
  })

  it('the ATS host match is domain-boundary: a lookalike host gets no ATS treatment', () => {
    expect(canonicalUrl('https://notgreenhouse.io/j/1?ref=a')).toBe('notgreenhouse.io/j/1?ref=a')
    expect(canonicalUrl('https://evil-greenhouse.io.attacker.com/j/1?source=a'))
      .toBe('evil-greenhouse.io.attacker.com/j/1?source=a')
  })

  it('an ATS apex host itself matches (not only its subdomains)', () => {
    expect(canonicalUrl('https://greenhouse.io/j/1?ref=a')).toBe('greenhouse.io/j/1')
  })
})

describe('canonicalUrl from the shared list of ATSes (#42)', () => {
  it('a Lever address keeps ref/source: Lever is on the list with its switch off', () => {
    expect(canonicalUrl('https://jobs.lever.co/acme/0c1d2e3f/apply?ref=li&source=tw&lever-origin=applied'))
      .toBe('jobs.lever.co/acme/0c1d2e3f/apply?lever-origin=applied&ref=li&source=tw')
  })

  it('every other ATS on the list but Greenhouse and Ashby keeps them too', () => {
    expect(canonicalUrl('https://apply.workable.com/acme/j/6?ref=a')).toBe('apply.workable.com/acme/j/6?ref=a')
    expect(canonicalUrl('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/4?source=b'))
      .toBe('acme.wd5.myworkdayjobs.com/en-US/careers/job/4?source=b')
  })

  it('Greenhouse and Ashby hosts in any case and with www. still strip them', () => {
    expect(canonicalUrl('https://WWW.Boards.Greenhouse.IO/acme/jobs/1?ref=a')).toBe('boards.greenhouse.io/acme/jobs/1')
    expect(canonicalUrl('https://jobs.ashbyhq.com/acme/1?source=a')).toBe('jobs.ashbyhq.com/acme/1')
  })
})
