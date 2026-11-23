import { z } from 'zod'
import type { CodexRunner } from './codexCli.js'
import type { CallOpts } from './claudeCli.js'
import { CAPS, UNTRUSTED_PREAMBLE, fence } from './fence.js'
import { buildTrustedContext, type GenerationInput } from './generate.js'

/** What may support a claim, named block by block, as the writer's rules name them (spec #98). */
const TRUSTED = 'The trusted blocks are CANDIDATE FACTS, CANDIDATE CV, PROJECT NOTES, ABOUT ME and SAVED ANSWERS: in SAVED ANSWERS, the answers are the candidate\'s own and support a claim, while the fenced questions are page text and support none. Any of them that is absent above supports nothing.'

// `unsupported` is optional so a reply in the old shape, `{draft}`, still
// reads as a checked Draft that flagged nothing.
const ReviewResponseSchema = z.object({ draft: z.string(), unsupported: z.array(z.string()).nullish() })

/** What the Draft check returns: the checked Draft and the sentences it flagged
 *  as stating something about the user the stored material does not support. */
export interface CheckedDraft { draft: string; unsupported: string[] }

/** B2d: the Draft check, the gpt-sol reviewer pass. Same trusted/untrusted
 *  context as the drafting prompt, plus the claude draft; it removes ungrounded
 *  factual claims and tightens wording — it never adds new claims — and flags,
 *  without removing, any other sentence about the candidate that the trusted
 *  blocks do not support. */
export function buildReviewPrompt(input: GenerationInput, claudeDraft: string): string {
  return [
    'You review ONE drafted answer to a job-application question, keeping the candidate\'s voice.',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    ...buildTrustedContext(input),
    '',
    'DRAFT under review:',
    fence('draft_under_review', claudeDraft, CAPS.answer),
    '',
    TRUSTED,
    '',
    'Rewrite the draft, applying ONLY these fixes:',
    '1. Remove or correct any factual claim (employer, technology, metric, degree, date) not grounded in the trusted blocks above. Never add a new factual claim.',
    '2. Tighten wording; cut filler, repetition and generic flattery.',
    '3. Keep the first person and the candidate\'s plain voice.',
    '4. Keep the language of the question. 60 to 150 words unless the question asks for something longer.',
    '5. Never use a spaced em-dash or en-dash as sentence punctuation.',
    'If the draft is already grounded and tight, return it unchanged.',
    '',
    'Then list, under "unsupported", every sentence of your rewritten draft that states something about the candidate',
    '(a need, a circumstance, a preference or a piece of history, such as having no accommodation needs) which the',
    'trusted blocks above do not support. Do not remove or rewrite such a sentence for this reason: leave it in the draft,',
    'and copy it into "unsupported" exactly as it appears in the draft. A sentence the trusted blocks support, an opinion',
    'about the job or the Company, or a fix you already made under rule 1 does not go in the list. When there is none,',
    'return an empty list.',
    '',
    'Return {"draft": "...", "unsupported": ["..."]}.',
  ].join('\n')
}

export async function reviewDraft(runner: CodexRunner, input: GenerationInput, claudeDraft: string, opts: CallOpts): Promise<CheckedDraft> {
  const out = await runner.complete(buildReviewPrompt(input, claudeDraft), ReviewResponseSchema, opts)
  return { draft: out.draft, unsupported: out.unsupported ?? [] }
}
