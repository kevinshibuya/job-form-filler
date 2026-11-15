import { describe, it, expect } from 'vitest'
import { claimsInDraft } from './draftCheck.js'
import { sanitizeDraft } from './generate.js'

/**
 * A sentence the Draft check flags is quoted to the user only when the Draft
 * the host returns contains it, after the Draft's own clean-up and ignoring
 * differences in spacing.
 */

const DRAFT = sanitizeDraft(
  'I would love to join Acme. I do not need any accommodations. I can start soon — next month works.',
)

describe('claimsInDraft', () => {
  it('keeps a flagged sentence the Draft contains', () => {
    expect(claimsInDraft(DRAFT, ['I do not need any accommodations.'])).toEqual(['I do not need any accommodations.'])
  })

  it('keeps a flagged sentence that differs from the Draft only in spacing, quoted as the Draft has it', () => {
    expect(claimsInDraft(DRAFT, ['  I do not  need any\naccommodations .'])).toEqual(['I do not need any accommodations.'])
    expect(claimsInDraft(DRAFT, ['Idonotneedanyaccommodations.'])).toEqual(['I do not need any accommodations.'])
  })

  it('treats the characters of a flagged sentence literally', () => {
    expect(claimsInDraft(DRAFT, ['I do not need any (accommodations).'])).toEqual([])
    expect(claimsInDraft(DRAFT, ['I do not need any .*'])).toEqual([])
  })

  it('keeps a flagged sentence whose dash the clean-up rewrote in the Draft', () => {
    expect(claimsInDraft(DRAFT, ['I can start soon — next month works.'])).toEqual(['I can start soon, next month works.'])
    expect(claimsInDraft(DRAFT, ['I can start soon – next month works.'])).toEqual(['I can start soon, next month works.'])
  })

  it('drops a flagged sentence the Draft does not contain', () => {
    expect(claimsInDraft(DRAFT, ['I have no disability.'])).toEqual([])
    expect(claimsInDraft(DRAFT, ['I do not need any accommodations.', 'I have no disability.']))
      .toEqual(['I do not need any accommodations.'])
  })

  it('drops an empty flag and quotes a repeated one once', () => {
    expect(claimsInDraft(DRAFT, ['', '   ', 'I do not need any accommodations.', 'I do not need any  accommodations.']))
      .toEqual(['I do not need any accommodations.'])
  })

  it('gives nothing for no flags', () => {
    expect(claimsInDraft(DRAFT, [])).toEqual([])
  })
})
