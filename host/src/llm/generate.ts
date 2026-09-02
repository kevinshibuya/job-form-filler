import { z } from 'zod'
import type { CallOpts, ClaudeRunner } from './claudeCli.js'
import { CAPS, UNTRUSTED_PREAMBLE, fence } from './fence.js'

export interface GenerationInput {
  question: string
  /** Page-provided helper text under the question (A4) — untrusted like the label. */
  description: string | null
  jobText: string
  company: string | null
  /** Trusted, user-authored facts. This is the ONLY thing a claim may rest on. */
  profileSummary: string
  /** B2b: extracted resume text — trusted, candidate-authored. null = none. */
  cvText: string | null
  /** B2c: local project notes — trusted, candidate-authored. null = none. */
  projectNotes: string | null
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

/** The context both the drafting and the reviewing prompt share: trusted
 *  candidate-authored blocks, then the fenced untrusted page material. */
export function buildTrustedContext(input: GenerationInput): string[] {
  return [
    'CANDIDATE FACTS (trusted, written by the candidate):',
    input.profileSummary.slice(0, CAPS.jobText),
    '',
    ...(input.cvText === null ? [] : [
      "CANDIDATE CV (trusted, from the candidate's own resume):",
      input.cvText.slice(0, CAPS.jobText),
      '',
    ]),
    ...(input.projectNotes === null ? [] : [
      "PROJECT NOTES (trusted, the candidate's own project documentation):",
      input.projectNotes.slice(0, CAPS.jobText),
      '',
    ]),
    `Company: ${input.company === null ? '(unknown)' : fence('field_label', input.company, CAPS.label)}`,
    fence('job_post', input.jobText, CAPS.jobText),
    '',
    'Question to answer:',
    fence('field_label', input.question, CAPS.label),
    ...(input.description === null || input.description === ''
      ? []
      : ['Additional page-provided guidance for this question:', fence('field_description', input.description, CAPS.description)]),
  ]
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
    ...buildTrustedContext(input),
    '',
    'Earlier drafts the candidate wrote for this same question at OTHER companies.',
    'These are reference only: reuse the reasoning, never the company-specific wording.',
    refs,
    '',
    'Rules for the draft:',
    '1. Write in the first person as the candidate.',
    '2. Factual claims (employers, technologies, metrics, degrees, dates) may come ONLY from the CANDIDATE FACTS, CANDIDATE CV or PROJECT NOTES blocks. Never invent an employer, a technology, a metric, a degree or a year.',
    '3. If a FACTUAL question has no basis in those blocks, say what is missing plainly in one sentence instead of inventing something.',
    '4. A SUBJECTIVE question (motivation, "why us", preferences, working style, how an achievement shaped the candidate) is answered constructively by connecting the CV and project notes to the job post. Alignment between demonstrated work and the role is a truthful basis. When CV or project context exists, refusing a subjective question is forbidden.',
    '5. Match the language of the question. A Portuguese question gets a Portuguese answer.',
    '6. Plain prose. No bullet lists unless the question asks for a list.',
    '7. 60 to 150 words unless the question asks for something longer.',
    '8. Never use a spaced em-dash or en-dash as sentence punctuation. Use a comma, a semicolon or a full stop.',
    '9. No filler openers such as "I am thrilled to" or "I am passionate about".',
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

export async function runGeneration(runner: ClaudeRunner, input: GenerationInput, opts: CallOpts): Promise<string> {
  const out = await runner.complete(buildGenerationPrompt(input), GenerationResponseSchema, opts)
  return sanitizeDraft(out.draft)
}
