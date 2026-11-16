import { describe, expect, it } from 'vitest'
import { registrableDomain, sameApplication, sameSite } from './site'

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

// PR #36 manual pass 2: on a multi-tenant ATS host every company's posting is
// one registrable domain, so a session crossed to another company's posting.
describe('sameApplication: same site, and not a different posting', () => {
  const GH = 'https://job-boards.greenhouse.io/acme/jobs/8038026003'
  const LEVER = 'https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666'
  const WD = 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/London/Engineer_JR-0012345'
  it.each([
    [GH, 'https://job-boards.greenhouse.io/globex/jobs/8209762', false],
    [GH, 'https://job-boards.greenhouse.io/acme/jobs/4399058009', false],
    [GH, `${GH}/confirmation`, true],
    [GH, `${GH}?gh_src=abc`, true],
    [GH, 'https://job-boards.greenhouse.io/acme', true],
    [GH, 'https://www.google.com/search?q=x', false],
    ['https://jobs.acme.com/apply', 'https://careers.acme.com/apply/step2', true],
    ['https://jobs.acme.com/apply', 'https://jobs.acme.com/apply/done', true],
    ['https://jobs.acme.com/apply', 'https://jobs.globex.com/apply', false],
    ['http://127.0.0.1:53211/wizard-step1.html?tab=a', 'http://127.0.0.1:53211/wizard-step2.html', true],
    [LEVER, `${LEVER}/apply`, true],
    [LEVER, 'https://jobs.lever.co/globex/9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff', false],
    [WD, `${WD}/apply/applyManually`, true],
    [`${WD}/apply`, 'https://acme.wd5.myworkdayjobs.com/en-US/External/login?redirect=%2Fen-US%2FExternal%2Fjob%2FLondon%2FEngineer_JR-0012345%2Fapply', true],
    ['https://careers.acme.com/jobs/12345', 'https://jobs.acme.com/apply/12345/step1', true],
    ['https://careers.acme.com/jobs/12345', 'https://careers.acme.com/auth/callback?code=AbC123456xyz&state=xyz', true],
    ['https://careers.acme.com/careers?jid=0a1b2c3d-1111-2222-3333-444455556666', 'https://careers.acme.com/careers?jid=9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff', false],
  ])('%s then %s: %s', (start, next, expected) => {
    expect(sameApplication(next, start)).toBe(expected)
  })
})
