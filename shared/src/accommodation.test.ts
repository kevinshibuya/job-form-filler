import { describe, it, expect } from 'vitest'
import { ACCOMMODATION_REASON, asksAboutAccommodation } from './accommodation.js'

describe('asksAboutAccommodation: a rule on the label, never a model', () => {
  it('recognises the English wordings', () => {
    for (const label of [
      'Do you need any accommodation during the interview process?',
      'Do you require any accommodations?',
      'Is there anything we can do to accommodate you?',
      'ACCOMMODATION REQUESTS',
    ]) expect(asksAboutAccommodation(label), label).toBe(true)
  })

  it('recognises the Portuguese wordings, with and without accents', () => {
    for (const label of [
      'Você precisa de alguma acomodação para a entrevista?',
      'Voce precisa de alguma acomodacao para a entrevista?',
      'Precisa de alguma adaptação no processo seletivo?',
      'Precisa de alguma adaptacao no processo seletivo?',
    ]) expect(asksAboutAccommodation(label), label).toBe(true)
  })

  it('answers no for a question about anything else, and for no label', () => {
    for (const label of [
      'Why do you want this role?',
      'Which versions of TypeScript have you worked with?',
      'Can you be on site one day a week?',
      '',
    ]) expect(asksAboutAccommodation(label), label).toBe(false)
    expect(asksAboutAccommodation(null)).toBe(false)
  })

  it('names the reason a Resolution carries for such a Field', () => {
    expect(ACCOMMODATION_REASON).toBe('accommodation')
  })
})
