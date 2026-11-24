import { describe, expect, it } from 'vitest'
import { ADDRESS_CONTEXTS_MAX, APPLY_CANDIDATES_MAX, type AddressContext, type FoundAddress } from '@jff/shared'
import { collectAddresses } from '../content/addresses'
import { loadEmailFixture } from '../content/fixtures/real'
import { mergeCandidates } from './applyAddressCandidates'
import { pageSubjectFor } from './emailDraft'

/**
 * The Side panel merges the frames' address lists into Apply address
 * candidates (spec #66): one candidate per address, whatever its case, with
 * its contexts in page order up to a cap, a capped list, and never the user's
 * own email address.
 */

const text = (sentence: string): AddressContext => ({ kind: 'text', sentence })
const mailto = (linkText: string, subject: string | null = null): AddressContext => ({ kind: 'mailto', linkText, subject })
const at = (address: string, context: AddressContext): FoundAddress => ({ address, context })

describe('merging the frames\' addresses', () => {
  it('on the careers-page fixture holds two candidates, the posting\'s address first with its subject', () => {
    loadEmailFixture('careers-page')
    const candidates = mergeCandidates([collectAddresses(document)], null)
    expect(candidates.map((c) => c.address)).toEqual(['address-1@example.org', 'address-2@example.org'])
    expect(candidates[0]!.contexts[0]).toEqual(mailto('Mail je sollicitatie', 'Sollicitatie: Senior full-stack developer'))
    expect(candidates[0]!.contexts.some((c) => c.kind === 'text')).toBe(true)
  })

  it('keeps an address found only in a frame other than the top one', () => {
    const candidates = mergeCandidates([[], [at('framed@example.org', text('Apply at framed@example.org.'))]], null)
    expect(candidates).toEqual([{ address: 'framed@example.org', contexts: [text('Apply at framed@example.org.')] }])
  })

  it('makes one candidate of the same address in two cases, with each context in page order', () => {
    const candidates = mergeCandidates([
      [at('Jobs@Example.org', text('Write to Jobs@Example.org.'))],
      [at('jobs@example.org', mailto('Apply'))],
    ], null)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.address).toBe('Jobs@Example.org')
    expect(candidates[0]!.contexts).toEqual([text('Write to Jobs@Example.org.'), mailto('Apply')])
  })

  it('keeps a context the page repeats once', () => {
    const link = at('jobs@example.org', mailto('Apply', 'Application'))
    expect(mergeCandidates([[link, link, link]], null)[0]!.contexts).toEqual([mailto('Apply', 'Application')])
  })

  it('never lists the user\'s own email address, whatever its case', () => {
    const candidates = mergeCandidates([[
      at('ADA@example.com', text('Signed in as ADA@example.com.')),
      at('jobs@example.org', mailto('Apply')),
    ]], ' ada@example.com ')
    expect(candidates.map((c) => c.address)).toEqual(['jobs@example.org'])
  })

  it('stops a candidate\'s contexts at their cap', () => {
    const many = Array.from({ length: ADDRESS_CONTEXTS_MAX + 4 }, (_, i) => at('jobs@example.org', text(`Sentence ${i}.`)))
    const contexts = mergeCandidates([many], null)[0]!.contexts
    expect(contexts).toHaveLength(ADDRESS_CONTEXTS_MAX)
    expect(contexts[0]).toEqual(text('Sentence 0.'))
  })

  it('keeps the first mailto: subject found past the cap, so the page\'s subject is not lost (#88)', () => {
    const found = [
      ...Array.from({ length: ADDRESS_CONTEXTS_MAX }, (_, i) => at('jobs@example.org', text(`Sentence ${i}.`))),
      at('jobs@example.org', mailto('Mail us')),
      at('jobs@example.org', mailto('Apply here', 'Application: analyst')),
      at('jobs@example.org', mailto('Apply again', 'A later subject')),
    ]
    const candidates = mergeCandidates([found], null)
    expect(candidates[0]!.contexts).toEqual([
      text('Sentence 0.'), text('Sentence 1.'), text('Sentence 2.'), mailto('Apply here', 'Application: analyst'),
    ])
    expect(pageSubjectFor(candidates, 'jobs@example.org')).toBe('Application: analyst')
  })

  it('adds no context past the cap when a kept one already sets a subject (#88)', () => {
    const found = [
      at('jobs@example.org', mailto('Apply', 'First')),
      ...Array.from({ length: ADDRESS_CONTEXTS_MAX }, (_, i) => at('jobs@example.org', text(`Sentence ${i}.`))),
      at('jobs@example.org', mailto('Apply here', 'Second')),
    ]
    expect(mergeCandidates([found], null)[0]!.contexts).toHaveLength(ADDRESS_CONTEXTS_MAX)
  })

  it('stops the list at its cap, keeping the first in page order', () => {
    const many = Array.from({ length: APPLY_CANDIDATES_MAX + 5 }, (_, i) => at(`a${i}@example.org`, mailto(`a${i}`)))
    const candidates = mergeCandidates([many], null)
    expect(candidates).toHaveLength(APPLY_CANDIDATES_MAX)
    expect(candidates[0]!.address).toBe('a0@example.org')
    expect(candidates.at(-1)!.address).toBe(`a${APPLY_CANDIDATES_MAX - 1}@example.org`)
  })

  it('gives no candidates for no addresses', () => {
    expect(mergeCandidates([], 'ada@example.com')).toEqual([])
    expect(mergeCandidates([[], []], null)).toEqual([])
  })
})
