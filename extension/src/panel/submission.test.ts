import { describe, expect, it } from 'vitest'
import { detectSubmission } from './submission'

describe('detectSubmission (A3)', () => {
  it('fires when fillable fields went >0 to 0', () => {
    expect(detectSubmission({ prevFields: 4, newFields: 0, pageText: '' })).toBe(true)
  })

  it('does NOT fire on a fresh page that never had fields', () => {
    expect(detectSubmission({ prevFields: 0, newFields: 0, pageText: 'anything' })).toBe(false)
  })

  it.each([
    ['en', 'Thank you for applying to Acme!'],
    ['en', 'Your application submitted successfully.'],
    ['en', 'Application received — we will be in touch.'],
    ['pt', 'Obrigado por se candidatar!'],
    ['pt', 'Candidatura enviada com sucesso.'],
    ['pt', 'Recebemos sua candidatura.'],
  ])('fires on the %s confirmation text regardless of field counts', (_lang, text) => {
    expect(detectSubmission({ prevFields: 3, newFields: 3, pageText: `header nav ${text} footer` })).toBe(true)
  })

  it('never fires on an ordinary wizard step page', () => {
    expect(detectSubmission({ prevFields: 3, newFields: 5, pageText: 'Tell us more about your experience. Voluntary self-identification.' })).toBe(false)
  })

  it('survives whitespace and case noise in the page text', () => {
    expect(detectSubmission({ prevFields: 1, newFields: 1, pageText: 'THANK  YOU\n FOR   APPLYING' })).toBe(true)
  })
})
