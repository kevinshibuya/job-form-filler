import { z } from 'zod'
import type { CodexRunner } from './codexCli.js'
import { CAPS, UNTRUSTED_PREAMBLE } from './fence.js'
import { buildTrustedContext, type GenerationInput } from './generate.js'

const ReviewResponseSchema = z.object({ draft: z.string() })

/** B2d: the gpt-sol reviewer pass. Same trusted/untrusted context as the
 *  drafting prompt, plus the claude draft; it removes ungrounded factual
 *  claims and tightens wording — it never adds new claims. */
export function buildReviewPrompt(input: GenerationInput, claudeDraft: string): string {
  return [
    'You review ONE drafted answer to a job-application question, keeping the candidate\'s voice.',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    ...buildTrustedContext(input),
    '',
    'DRAFT under review:',
    claudeDraft.slice(0, CAPS.answer),
    '',
    'Rewrite the draft, applying ONLY these fixes:',
    '1. Remove or correct any factual claim (employer, technology, metric, degree, date) not grounded in the trusted blocks above. Never add a new factual claim.',
    '2. Tighten wording; cut filler, repetition and generic flattery.',
    '3. Keep the first person and the candidate\'s plain voice.',
    '4. Keep the language of the question. 60 to 150 words unless the question asks for something longer.',
    '5. Never use a spaced em-dash or en-dash as sentence punctuation.',
    'If the draft is already grounded and tight, return it unchanged.',
    '',
    'Return {"draft": "..."}.',
  ].join('\n')
}

export async function reviewDraft(runner: CodexRunner, input: GenerationInput, claudeDraft: string): Promise<string> {
  const out = await runner.complete(buildReviewPrompt(input, claudeDraft), ReviewResponseSchema)
  return out.draft
}
