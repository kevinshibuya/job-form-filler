import { z } from 'zod'
import type { CallOpts } from './claudeCli.js'
import type { CodexRunner } from './codexCli.js'
import { CAPS, UNTRUSTED_PREAMBLE, fence } from './fence.js'

/** What the Option pick is shown: the Field's label, the stored Value, the page's Options. */
export interface OptionPickInput {
  label: string
  value: string
  options: string[]
}

/**
 * ANTI-FABRICATION INVARIANT, structural form (ADR 0008).
 * The model answers a position and nothing else: the schema has no text
 * property and zod strips unknown keys. A position is turned back into one of
 * the Options the request carried, or none.
 */
const OptionPickReplySchema = z.object({ position: z.number().int().nullable() })

export function buildOptionPickPrompt(input: OptionPickInput): string {
  const options = input.options.slice(0, CAPS.optionsPerField)
    .map((o, i) => `- position=${i} ${fence('option', o, CAPS.option)}`)
    .join('\n')
  return [
    'You match a stored answer to one of the options a job-application form offers. You do NOT write answers.',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    `Question: ${fence('field_label', input.label, CAPS.label)}`,
    `The applicant's stored answer: ${fence('stored_answer', input.value, CAPS.answer)}`,
    '',
    'Options the form offers:',
    options,
    '',
    'Return {"position": N} with N the position of the ONE option that says the same thing as the stored answer.',
    'Return {"position": null} when no option says it, when several could, or when the option would claim',
    'something the stored answer does not.',
    '',
    'Hard rules:',
    '- position MUST be one of the positions listed above, or null.',
    '- Do not write, guess, translate or paraphrase any answer text. You only point at an option.',
  ].join('\n')
}

/** The position the reply points at, or null when it is none, not a position,
 *  or outside the `count` Options that were sent. */
export function validateOptionPick(raw: unknown, count: number): number | null {
  const parsed = OptionPickReplySchema.safeParse(raw)
  if (!parsed.success) return null
  const { position } = parsed.data
  return position !== null && position >= 0 && position < count ? position : null
}

export async function runOptionPick(runner: CodexRunner, input: OptionPickInput, opts: CallOpts): Promise<number | null> {
  const count = Math.min(input.options.length, CAPS.optionsPerField)
  if (count === 0) return null
  // Parsed as `unknown`: validateOptionPick owns every rule, so a reply that
  // fails the schema and one that points outside the Options both answer none.
  const raw = await runner.complete(buildOptionPickPrompt(input), z.unknown(), opts)
  return validateOptionPick(raw, count)
}
