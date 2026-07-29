import { describe, it, expect, vi } from 'vitest'
import type { GenerationInput } from './generate.js'
import type { CodexRunner } from './codexCli.js'
import { buildReviewPrompt, reviewDraft } from './reviewDraft.js'

const input: GenerationInput = {
  question: 'Why do you want to work at Acme?',
  description: null,
  jobText: 'Acme builds payment rails.',
  company: 'Acme',
  profileSummary: 'Name: Kevin Shibuya',
  cvText: 'Built a job-form filler extension.',
  projectNotes: null,
  references: [],
}

describe('buildReviewPrompt', () => {
  const prompt = buildReviewPrompt(input, 'THE CLAUDE DRAFT')

  it('carries the same trusted/untrusted context as generation, plus the draft', () => {
    expect(prompt).toContain('CANDIDATE FACTS')
    expect(prompt).toContain("CANDIDATE CV (trusted, from the candidate's own resume):")
    expect(prompt).toContain('<job_post>')
    expect(prompt).toContain('<field_label>Why do you want to work at Acme?</field_label>')
    expect(prompt).toContain('THE CLAUDE DRAFT')
    expect(prompt).toMatch(/UNTRUSTED data/)
  })

  it('states the reviewer rules: ground facts, tighten, keep voice/length/language', () => {
    expect(prompt).toMatch(/Remove or correct any factual claim .* not grounded/i)
    expect(prompt).toMatch(/Tighten wording/i)
    expect(prompt).toMatch(/return it unchanged/i)
  })
})

describe('reviewDraft', () => {
  it('returns the reviewer draft', async () => {
    const runner = { complete: vi.fn(async () => ({ draft: 'refined' })) } as unknown as CodexRunner
    await expect(reviewDraft(runner, input, 'original')).resolves.toBe('refined')
  })

  it('propagates a codex failure to the caller (the handler degrades, not this module)', async () => {
    const runner = { complete: vi.fn(async () => { throw new Error('codex died') }) } as unknown as CodexRunner
    await expect(reviewDraft(runner, input, 'original')).rejects.toThrow('codex died')
  })
})
