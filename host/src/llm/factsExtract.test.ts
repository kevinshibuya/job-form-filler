import { describe, it, expect, vi } from 'vitest'
import type { ClaudeRunner } from './claudeCli.js'
import { buildFactsExtractPrompt, runFactsExtract } from './factsExtract.js'

describe('buildFactsExtractPrompt', () => {
  const prompt = buildFactsExtractPrompt('CV BODY TEXT')

  it('carries the CV text and every fact key', () => {
    expect(prompt).toContain('CV BODY TEXT')
    for (const k of ['firstName', 'lastName', 'fullName', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio', 'workAuth', 'sponsorshipNeeded', 'relocate', 'salary', 'notice', 'earliestStart', 'remotePreference', 'pronouns', 'preferredName']) {
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
    } as unknown as ClaudeRunner
    await expect(runFactsExtract(runner, 'CV')).resolves.toEqual({ email: 'k@x.com', salary: 'R$ 18k' })
  })
})
