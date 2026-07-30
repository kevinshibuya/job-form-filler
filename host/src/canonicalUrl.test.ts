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
})
