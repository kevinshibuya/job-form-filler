import { z } from 'zod'
import type { ClaudeRunner } from './claudeCli.js'
import { CAPS, UNTRUSTED_PREAMBLE, fence } from './fence.js'

export interface GenerationInput {
  question: string
  /** Page-provided helper text under the question (A4) — untrusted like the label. */
  description: string | null
  jobText: string
  company: string | null
  /** Trusted, user-authored facts. This is the ONLY thing a claim may rest on. */
  profileSummary: string
  /** Prior company_specific drafts for the same question — reference material only. */
  references: string[]
}

export const GenerationResponseSchema = z.object({ draft: z.string() })

export function buildProfileSummary(profile: Record<string, string>, bank: Record<string, string>): string {
  return [...Object.entries(profile), ...Object.entries(bank)]
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

export function buildGenerationPrompt(input: GenerationInput): string {
  const refs = input.references.length === 0
    ? '(none)'
    : input.references.map((r) => fence('stored_answer', r, CAPS.answer)).join('\n')

  return [
    'You draft one answer to a single job-application question, in the candidate\'s voice.',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    'CANDIDATE FACTS (trusted, written by the candidate):',
    input.profileSummary.slice(0, CAPS.jobText),
    '',
    `Company: ${input.company === null ? '(unknown)' : fence('field_label', input.company, CAPS.label)}`,
    fence('job_post', input.jobText, CAPS.jobText),
    '',
    'Question to answer:',
    fence('field_label', input.question, CAPS.label),
    ...(input.description === null || input.description === ''
      ? []
      : ['Additional page-provided guidance for this question:', fence('field_description', input.description, CAPS.description)]),
    '',
    'Earlier drafts the candidate wrote for this same question at OTHER companies.',
    'These are reference only: reuse the reasoning, never the company-specific wording.',
    refs,
    '',
    'Rules for the draft:',
    '1. Write in the first person as the candidate.',
    '2. Only state facts that appear in the CANDIDATE FACTS block. Never invent an employer, a technology, a metric, a degree or a year.',
    '3. If the question cannot be answered truthfully from those facts, say so plainly in one sentence instead of inventing something.',
    '4. Match the language of the question. A Portuguese question gets a Portuguese answer.',
    '5. Plain prose. No bullet lists unless the question asks for a list.',
    '6. 60 to 150 words unless the question asks for something longer.',
    '7. Never use a spaced em-dash or en-dash as sentence punctuation. Use a comma, a semicolon or a full stop.',
    '8. No filler openers such as "I am thrilled to" or "I am passionate about".',
    '',
    'Return {"draft": "..."}.',
  ].join('\n')
}

/** Belt and braces for rule 7, plus a hard length cap. */
export function sanitizeDraft(s: string): string {
  return s
    .replace(/\s+[—–]\s+/g, ', ')
    .trim()
    .slice(0, CAPS.answer)
}

export async function runGeneration(runner: ClaudeRunner, input: GenerationInput): Promise<string> {
  const out = await runner.complete(buildGenerationPrompt(input), GenerationResponseSchema)
  return sanitizeDraft(out.draft)
}
