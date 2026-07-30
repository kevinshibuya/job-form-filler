import { describe, expect, it } from 'vitest'
import { registrableDomain, sameSite } from './site'

describe('registrableDomain / sameSite (S5)', () => {
  it.each([
    ['https://jobs.acme.com/apply', 'acme.com'],
    ['https://careers.acme.com/x', 'acme.com'],
    ['https://acme.com/', 'acme.com'],
    ['https://www.trmlabs.com/careers?ashby_jid=1', 'trmlabs.com'],
    ['https://job-boards.greenhouse.io/x/jobs/1', 'greenhouse.io'],
    ['https://foo.bar.co.uk/x', 'bar.co.uk'],
    ['https://empresa.com.br/vagas', 'empresa.com.br'],
    ['not a url', ''],
  ])('%s → %s', (url, domain) => {
    expect(registrableDomain(url)).toBe(domain)
  })

  it('sameSite: subdomains of one registrable domain match; unparseable never matches', () => {
    expect(sameSite('https://jobs.acme.com/a', 'https://careers.acme.com/b')).toBe(true)
    expect(sameSite('https://acme.com', 'https://acme.io')).toBe(false)
    expect(sameSite('', '')).toBe(false)
  })
})
