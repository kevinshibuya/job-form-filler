import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADDRESS_SENTENCE_MAX, type FoundAddress } from '@jff/shared'
import { collectAddresses } from './addresses'
import { EMAIL_FIXTURES, loadEmailFixture } from './fixtures/real'

/**
 * Address collection (spec #66): each frame's page script reads the addresses
 * of its own document in the pass that enumerates its Fields. A `mailto:` link
 * gives its address with its link text and subject; an address in the visible
 * text gives the sentence around it. The two email fixtures are sanitised real
 * pages, every address a numbered placeholder on example.org.
 */

function page(html: string): void {
  document.body.innerHTML = html
}

const addressesOf = (found: FoundAddress[]): string[] => found.map((f) => f.address)

afterEach(() => { vi.restoreAllMocks() })

describe('the careers-page fixture', () => {
  it('is read by name', () => {
    expect(EMAIL_FIXTURES).toEqual(['careers-page', 'job-board-page'])
  })

  it('gives the mailto: address with its link text and its subject', () => {
    loadEmailFixture('careers-page')
    const mailto = collectAddresses(document).filter((f) => f.address === 'address-1@example.org' && f.context.kind === 'mailto')
    expect(mailto.length).toBeGreaterThan(0)
    expect(mailto[0]!.context).toEqual({ kind: 'mailto', linkText: 'Mail je sollicitatie', subject: 'Sollicitatie: Senior full-stack developer' })
  })

  it('gives the footer address, a link with no subject', () => {
    loadEmailFixture('careers-page')
    const footer = collectAddresses(document).filter((f) => f.address === 'address-2@example.org')
    expect(footer).toEqual([{ address: 'address-2@example.org', context: { kind: 'mailto', linkText: 'address-2@example.org', subject: null } }])
  })

  it('gives the address the steps text names, with its sentence, and nothing else', () => {
    loadEmailFixture('careers-page')
    const found = collectAddresses(document)
    expect(new Set(addressesOf(found))).toEqual(new Set(['address-1@example.org', 'address-2@example.org']))
    const text = found.filter((f) => f.context.kind === 'text')
    expect(text).toHaveLength(1)
    expect(text[0]!.address).toBe('address-1@example.org')
  })

  it('lists the page\'s addresses in page order', () => {
    loadEmailFixture('careers-page')
    const found = collectAddresses(document)
    expect(found[0]!.context.kind).toBe('mailto')
    expect(found.at(-1)!.address).toBe('address-2@example.org')
  })
})

describe('the job-board fixture', () => {
  it('gives the one address with the sentence around it', () => {
    loadEmailFixture('job-board-page')
    const found = collectAddresses(document)
    expect(addressesOf(found)).toEqual(['address-1@example.org'])
    const ctx = found[0]!.context
    expect(ctx.kind).toBe('text')
    if (ctx.kind !== 'text') return
    expect(ctx.sentence).toContain('address-1@example.org')
    expect(ctx.sentence).toContain('Placeholder text')
    expect(ctx.sentence.length).toBeLessThanOrEqual(ADDRESS_SENTENCE_MAX)
  })
})

describe('a mailto: link', () => {
  it('with two recipients gives one address each, and its body, cc and bcc leave no trace', () => {
    page('<a href="mailto:first@example.org,second@example.org?subject=Hello%20there&body=secret-body-text&cc=copy@example.org&bcc=blind@example.org">Write to us</a>')
    const found = collectAddresses(document)
    expect(found).toEqual([
      { address: 'first@example.org', context: { kind: 'mailto', linkText: 'Write to us', subject: 'Hello there' } },
      { address: 'second@example.org', context: { kind: 'mailto', linkText: 'Write to us', subject: 'Hello there' } },
    ])
    const json = JSON.stringify(found)
    for (const gone of ['secret-body-text', 'copy@example.org', 'blind@example.org']) expect(json).not.toContain(gone)
  })

  it('decodes a percent-encoded address and reads the scheme in any case', () => {
    page('<a href="MAILTO:jobs%40example.org">Apply</a>')
    expect(collectAddresses(document)).toEqual([{ address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply', subject: null } }])
  })

  it('keeps a plus sign in the subject and in an address, as RFC 6068 reads them (#89)', () => {
    page('<a href="mailto:jobs@example.org?to=ada+jobs@example.org&subject=C++%20Developer">Apply</a>')
    expect(collectAddresses(document)).toEqual([
      { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply', subject: 'C++ Developer' } },
      { address: 'ada+jobs@example.org', context: { kind: 'mailto', linkText: 'Apply', subject: 'C++ Developer' } },
    ])
  })

  it('collapses a line break and runs of spaces in the subject to one space (#89)', () => {
    page('<a href="mailto:jobs@example.org?subject=%20Senior%0A%0D%0Aanalyst%09%20role%20">Apply</a>')
    expect(collectAddresses(document)[0]!.context).toEqual({ kind: 'mailto', linkText: 'Apply', subject: 'Senior analyst role' })
  })

  it('decodes each escape and keeps a percent sign that is not one (#89)', () => {
    const subjectOf = (query: string): string | null => {
      page(`<a href="mailto:jobs@example.org?${query}">Apply</a>`)
      const ctx = collectAddresses(document)[0]!.context
      return ctx.kind === 'mailto' ? ctx.subject : null
    }
    expect(subjectOf('subject=100%%20remote')).toBe('100% remote')
    expect(subjectOf('subject=Engineer%20-%20100% remote')).toBe('Engineer - 100% remote')
    expect(subjectOf('subject=Caf%E9%20role')).toBe('Caf\ufffd role')
  })

  it('turns control characters in the subject into single spaces (#89)', () => {
    page('<a href="mailto:jobs@example.org?subject=Senior%00analyst%1B%7Frole">Apply</a>')
    expect(collectAddresses(document)[0]!.context).toEqual({ kind: 'mailto', linkText: 'Apply', subject: 'Senior analyst role' })
  })

  it('reads its header names in any case (#89)', () => {
    page('<a href="mailto:jobs@example.org?Subject=Hello&amp;TO=second@example.org">Apply</a>')
    expect(collectAddresses(document)).toEqual([
      { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply', subject: 'Hello' } },
      { address: 'second@example.org', context: { kind: 'mailto', linkText: 'Apply', subject: 'Hello' } },
    ])
  })

  it('keeps every to, the first subject, and skips empty pairs (#89)', () => {
    page('<a href="mailto:first@example.org?to=second@example.org&amp;&amp;to=third@example.org&amp;subject=First&amp;subject=Second&amp;flag">Apply</a>')
    const found = collectAddresses(document)
    expect(found.map((f) => f.address)).toEqual(['first@example.org', 'second@example.org', 'third@example.org'])
    for (const f of found) expect(f.context).toEqual({ kind: 'mailto', linkText: 'Apply', subject: 'First' })
  })

  it('with no address gives nothing', () => {
    page('<a href="mailto:?subject=Hi">Share</a><a href="mailto:not-an-address">x</a>')
    expect(collectAddresses(document)).toEqual([])
  })

  it('is not read a second time as page text', () => {
    page('<p>Send it to <a href="mailto:jobs@example.org">jobs@example.org</a> today.</p>')
    expect(collectAddresses(document).map((f) => f.context.kind)).toEqual(['mailto'])
  })
})

describe('an address in the page text', () => {
  it('gives the sentence around it', () => {
    page('<p>We read every letter. Send your CV to jobs@example.org before Friday. We answer in a week.</p>')
    expect(collectAddresses(document)).toEqual([
      { address: 'jobs@example.org', context: { kind: 'text', sentence: 'Send your CV to jobs@example.org before Friday.' } },
    ])
  })

  it('reads the sentence across inline markup', () => {
    page('<p>Questions? Write to <strong>jobs@example.org</strong> and say hello.</p>')
    expect(collectAddresses(document)[0]!.context).toEqual({ kind: 'text', sentence: 'Write to jobs@example.org and say hello.' })
  })

  it('cuts a long sentence to the fixed length, keeping the address', () => {
    const words = 'lorem ipsum dolor sit amet '.repeat(40)
    page(`<p>${words}write to jobs@example.org ${words}</p>`)
    const ctx = collectAddresses(document)[0]!.context
    if (ctx.kind !== 'text') throw new Error('expected a text context')
    expect(ctx.sentence.length).toBeLessThanOrEqual(ADDRESS_SENTENCE_MAX)
    expect(ctx.sentence).toContain('jobs@example.org')
  })

  it('is not collected when the page obfuscates it', () => {
    page('<p>Write to jobs at example dot org, or jobs [at] example.org, or jobs(at)example(dot)org.</p>')
    expect(collectAddresses(document)).toEqual([])
  })

  it('is not collected from hidden text, a script or a style', () => {
    page('<p style="display:none">hidden@example.org</p><p hidden>also@example.org</p>'
      + '<script>var a = "script@example.org"</script><style>/* style@example.org */</style><p>seen@example.org</p>')
    expect(addressesOf(collectAddresses(document))).toEqual(['seen@example.org'])
  })

  it('drops the full stop that ends the sentence', () => {
    page('<p>Write to jobs@example.org.</p>')
    expect(addressesOf(collectAddresses(document))).toEqual(['jobs@example.org'])
  })
})

describe('collection', () => {
  it('reads a frame\'s own document, whichever frame it is', () => {
    const frame = document.createElement('iframe')
    document.body.innerHTML = ''
    document.body.append(frame)
    const inner = frame.contentDocument!
    inner.body.innerHTML = '<p>Apply at framed@example.org now.</p>'
    expect(addressesOf(collectAddresses(inner))).toEqual(['framed@example.org'])
  })

  it('makes no network request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open')
    loadEmailFixture('careers-page')
    collectAddresses(document)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(xhr).not.toHaveBeenCalled()
  })
})
