import { z } from 'zod'
import { asksAboutAccommodation, displayValue, isFieldKey, type FieldClass } from '@jff/shared'
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
  /** The Reusable Saved answers, in the order first saved, latest first
   *  (spec #98). A form answer and its Draft check read them; the Application
   *  email hands none. */
  savedAnswers: SavedAnswerPair[]
}

/** One Saved answer: its question, copied from a page and so untrusted, and
 *  the user's own answer, trusted. */
export interface SavedAnswerPair {
  question: string
  answer: string
}

/** The most the Saved answers block's pairs may take, in characters. */
export const SAVED_ANSWERS_MAX = 12_000

/** The block's name, as its header and the rules that point at it read it. */
const SAVED_ANSWERS = 'SAVED ANSWERS'

/**
 * The Saved answers block's pairs, one per line pair: the question fenced as
 * untrusted page text, the answer as the user wrote it. A pair whose question
 * asks about accommodation needs never goes in. Pairs go in newest first and
 * whole: one that does not fit what is left of the cap is left out, never cut.
 */
export function savedAnswerLines(pairs: readonly SavedAnswerPair[]): string[] {
  const out: string[] = []
  let used = 0
  for (const { question, answer } of pairs) {
    if (asksAboutAccommodation(question) || answer.trim() === '') continue
    // A blank line inside an answer would end the block early; it closes up.
    const pair = `Q: ${fence('stored_question', question, CAPS.label)}\nA: ${answer.trim().replace(/\n\s*\n/g, '\n')}`
    // The newline between this pair and the one before it counts too.
    const cost = pair.length + (out.length === 0 ? 0 : 1)
    if (used + cost > SAVED_ANSWERS_MAX) continue
    out.push(pair)
    used += cost
  }
  return out
}

/** What the writer of a form answer reads: the shared context, plus which
 *  rules it follows, a Prose Field's short narrative or a Personal-fact
 *  Field's direct answer from stored facts (spec #98). The Draft check reads
 *  the context alone. */
export interface FormAnswerInput extends GenerationInput {
  fieldClass: FieldClass
}

/** `missing`: what stored fact would let the writer answer, one line in
 *  English (spec #98). Absent, null or blank when the Draft is fully supported. */
export const GenerationResponseSchema = z.object({ draft: z.string(), missing: z.string().nullish() })

/** The longest gap line a reply carries, in characters. */
export const MISSING_MAX = 300

/** What the writer returns: the Draft, and the gap it named, null for none. */
export interface GenerationOutput {
  draft: string
  missing: string | null
}

/**
 * The stored facts as the model reads them. A typed Value is formatted from
 * its typed form (a yes as "Yes"); old text of a typed key is no Value and is
 * left out, as is any row that is not a Known key.
 */
export function buildProfileSummary(profile: Record<string, string>, bank: Record<string, string>): string {
  return [...Object.entries(profile), ...Object.entries(bank)]
    .flatMap(([k, v]) => {
      const shown = isFieldKey(k) ? displayValue(k, v) : null
      return shown === null || shown.trim() === '' ? [] : [`${k}: ${shown}`]
    })
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
    ...savedAnswersBlock(input.savedAnswers),
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

function savedAnswersBlock(pairs: readonly SavedAnswerPair[]): string[] {
  const lines = savedAnswerLines(pairs)
  return lines.length === 0 ? [] : [
    `${SAVED_ANSWERS} (trusted answers the candidate gave on earlier application forms, newest first. Each question was copied from a web page and is fenced; the answer after it is the candidate's own):`,
    ...lines,
    '',
  ]
}

/** The trusted blocks a factual claim may rest on, as the rules name them. */
export const TRUSTED_BLOCKS = `CANDIDATE FACTS, CANDIDATE CV, PROJECT NOTES or ${SAVED_ANSWERS} blocks`

/** A Prose Field: opinion, motivation or narrative, answered in a short paragraph. */
const PROSE_RULES = [
  'Rules for the draft:',
  '1. Write in the first person as the candidate.',
  `2. Factual claims (employers, technologies, metrics, degrees, dates) may come ONLY from the ${TRUSTED_BLOCKS}. Never invent an employer, a technology, a metric, a degree or a year.`,
  '3. If a FACTUAL question has no basis in those blocks, say what is missing plainly in one sentence instead of inventing something.',
  '4. A SUBJECTIVE question (motivation, "why us", preferences, working style, how an achievement shaped the candidate) is answered constructively by connecting the CV and project notes to the job post. Alignment between demonstrated work and the role is a truthful basis. When CV or project context exists, refusing a subjective question is forbidden.',
  '5. Match the language of the question. A Portuguese question gets a Portuguese answer.',
  '6. Plain prose. No bullet lists unless the question asks for a list.',
  '7. 60 to 150 words unless the question asks for something longer.',
  '8. Never use a spaced em-dash or en-dash as sentence punctuation. Use a comma, a semicolon or a full stop.',
  '9. No filler openers such as "I am thrilled to" or "I am passionate about".',
]

/** A Personal-fact Field: a question about the candidate, answered directly
 *  from what is stored about them and nothing else. */
const PERSONAL_FACT_RULES = [
  'This question asks for a fact about the candidate. Rules for the draft:',
  '1. Write in the first person as the candidate.',
  `2. Every fact about the candidate may come ONLY from the ${TRUSTED_BLOCKS}. Make no claim beyond them: never invent or infer an employer, a technology, a version, a number of years, an availability, a need or any other circumstance.`,
  '3. One to three sentences: a direct answer, no narrative, no motivation, no link to the job post.',
  '4. Write in the language of the question. A Portuguese question gets a Portuguese answer.',
  '5. A yes/no question opens with yes or no, in the language of the question ("Yes" or "No", "Sim" or "Não").',
  '6. If those blocks do not cover the question, say what is missing plainly in one sentence, in the language of the question, instead of inventing an answer. If they cover part of it, answer that part.',
  '7. Plain prose. No bullet lists unless the question asks for a list.',
  '8. Never use a spaced em-dash or en-dash as sentence punctuation. Use a comma, a semicolon or a full stop.',
  '9. No filler openers such as "I am thrilled to" or "I am passionate about".',
]

export function buildGenerationPrompt(input: FormAnswerInput): string {
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
    ...(input.fieldClass === 'prose' ? PROSE_RULES : PERSONAL_FACT_RULES),
    '',
    'Also name what is missing: when the blocks above do not fully support the draft, set "missing" to one line in English saying which stored fact about the candidate would let you answer the question. Leave "missing" out when the draft is fully supported.',
    '',
    'Return {"draft": "...", "missing": "..."}.',
  ].join('\n')
}

/** Belt and braces for rule 8: a spaced em-dash or en-dash becomes a comma. */
export function rewriteSpacedDashes(s: string): string {
  return s.replace(/\s+[—–]\s+/g, ', ')
}

/** The clean-up every Draft gets before it is returned: rule 8, plus a hard length cap. */
export function sanitizeDraft(s: string): string {
  return rewriteSpacedDashes(s)
    .trim()
    .slice(0, CAPS.answer)
}

/** One line, capped; a blank gap is no gap. */
export function sanitizeMissing(s: string | null | undefined): string | null {
  const line = (s ?? '').replace(/\s+/g, ' ').trim().slice(0, MISSING_MAX)
  return line === '' ? null : line
}

export async function runGeneration(runner: ClaudeRunner, input: FormAnswerInput, opts: CallOpts): Promise<GenerationOutput> {
  const out = await runner.complete(buildGenerationPrompt(input), GenerationResponseSchema, opts)
  return { draft: sanitizeDraft(out.draft), missing: sanitizeMissing(out.missing) }
}
