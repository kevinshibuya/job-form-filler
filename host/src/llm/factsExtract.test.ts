import { describe, it, expect, vi } from 'vitest'
import type { CodexRunner } from './codexCli.js'
import { buildFactsExtractPrompt, runFactsExtract } from './factsExtract.js'

describe('buildFactsExtractPrompt', () => {
  const prompt = buildFactsExtractPrompt('CV BODY TEXT')

  it('carries the CV text and every fact key', () => {
    expect(prompt).toContain('CV BODY TEXT')
    for (const k of ['firstName', 'lastName', 'fullName', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio', 'workAuth', 'sponsorshipNeeded', 'relocate', 'salary', 'notice', 'earliestStart', 'remotePreference', 'pronouns', 'preferredName', 'city', 'region', 'country', 'currentCompany', 'currentTitle']) {
      expect(prompt).toContain(`- ${k}`)
    }
  })

  it('instructs omission over guessing', () => {
    expect(prompt).toMatch(/omit a key rather than guess/i)
  })
})

describe('runFactsExtract', () => {
  it('returns only known keys with non-empty trimmed values', async () => {
    const runner = {
      complete: vi.fn(async () => ({ email: 'k@x.com', salary: ' R$ 18k ', github: '', ssn: '123' })),
    } as unknown as CodexRunner
    await expect(runFactsExtract(runner, 'CV', { model: 'gpt-5.6-sol' })).resolves.toEqual({ email: 'k@x.com', salary: 'R$ 18k' })
  })
})

describe('the five new Known keys', () => {
  it('the prompt names city, region and country apart from the location line, and the current company and title', () => {
    const prompt = buildFactsExtractPrompt('CV')
    expect(prompt).toMatch(/city, region, country/)
    expect(prompt).toMatch(/currentCompany, currentTitle/)
  })

  it('returns Values for the five keys when the Resume text holds them, and still drops a key outside the set', async () => {
    const runner = {
      complete: vi.fn(async () => ({
        fullName: 'Ada Lovelace', location: 'London, UK', city: 'London', region: 'Greater London', country: 'United Kingdom',
        currentCompany: ' Analytical Engines Ltd ', currentTitle: 'Mathematician', nationality: 'British',
      })),
    } as unknown as CodexRunner
    await expect(runFactsExtract(runner, 'Ada Lovelace, Mathematician at Analytical Engines Ltd, London, United Kingdom', { model: 'gpt-6.1-sol' }))
      .resolves.toEqual({
        fullName: 'Ada Lovelace', location: 'London, UK', city: 'London', region: 'Greater London', country: 'United Kingdom',
        currentCompany: 'Analytical Engines Ltd', currentTitle: 'Mathematician',
      })
  })
})
