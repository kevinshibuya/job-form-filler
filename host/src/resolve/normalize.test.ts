import { describe, it, expect } from 'vitest'
import { normalizeQuestion, detectLanguage } from './normalize.js'

describe('normalizeQuestion', () => {
  it('lowercases, strips accents, collapses punctuation and the required asterisk', () => {
    expect(normalizeQuestion('  Qual é a sua Pretensão Salarial? * ')).toBe('qual e a sua pretensao salarial')
  })

  it('makes two label spellings of the same question collide', () => {
    expect(normalizeQuestion('E-mail *')).toBe(normalizeQuestion('email'))
    expect(normalizeQuestion('Why do you want to join Figma?')).toBe('why do you want to join figma')
  })

  it('caps length so a pathological label cannot blow up a key', () => {
    expect(normalizeQuestion('a '.repeat(500)).length).toBeLessThanOrEqual(300)
  })

  it('returns an empty string for punctuation-only input', () => {
    expect(normalizeQuestion('*** ??? ')).toBe('')
  })
})

describe('detectLanguage', () => {
  it('detects PT-BR from stopwords and accents', () => {
    expect(detectLanguage('Qual é a sua pretensão salarial?')).toBe('pt')
    expect(detectLanguage('Você aceita trabalhar presencialmente?')).toBe('pt')
  })

  it('defaults to EN', () => {
    expect(detectLanguage('What is your salary expectation?')).toBe('en')
    expect(detectLanguage('')).toBe('en')
  })
})
