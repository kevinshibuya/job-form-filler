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
    // F10: an IP literal has no registrable domain — the suffix heuristic sliced
    // '127.0.0.1' down to '0.1', so every loopback origin looked like one site.
    ['http://127.0.0.1:3000/x', '127.0.0.1'],
    ['http://192.168.1.10/apply', '192.168.1.10'],
    ['http://[::1]:8080/x', '[::1]'],
    ['http://localhost:5173/x', 'localhost'],
  ])('%s → %s', (url, domain) => {
    expect(registrableDomain(url)).toBe(domain)
  })

  it('different local HOSTS are not one site; a different port on one host still is (F10)', () => {
    // Production impact is nil — every ATS is a named host. What the '0.1' slice
    // cost was any ability to tell local hosts apart at all. Ports are correctly
    // NOT part of a site, before or after: two fixture servers on 127.0.0.1
    // stayed same-site either way.
    expect(sameSite('http://127.0.0.1:3000/a', 'http://127.0.0.2:3000/b')).toBe(false)
    expect(sameSite('http://127.0.0.1:3000/a', 'http://localhost:3000/b')).toBe(false)
    expect(sameSite('http://127.0.0.1:3000/a', 'http://127.0.0.1:4000/b')).toBe(true)
  })

  it('sameSite: subdomains of one registrable domain match; unparseable never matches', () => {
    expect(sameSite('https://jobs.acme.com/a', 'https://careers.acme.com/b')).toBe(true)
    expect(sameSite('https://acme.com', 'https://acme.io')).toBe(false)
    expect(sameSite('', '')).toBe(false)
  })
})
