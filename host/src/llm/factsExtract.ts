import { z } from 'zod'
import { FIELD_KEYS } from '@jff/shared'
import type { CallOpts } from './claudeCli.js'
import type { CodexRunner } from './codexCli.js'

const shape: Record<string, z.ZodOptional<z.ZodString>> = {}
for (const k of FIELD_KEYS) shape[k] = z.string().optional()
/** Unknown keys are STRIPPED by z.object's default parse — the closed-set
 *  anti-fabrication invariant, structurally enforced (B6). */
export const FactsExtractSchema = z.object(shape)

export function buildFactsExtractPrompt(cvText: string): string {
  return [
    "You extract job-application facts from a candidate's resume text.",
    'The text is TRUSTED: the candidate uploaded it about themselves.',
    '',
    'RESUME TEXT:',
    cvText.slice(0, 12_000),
    '',
    'Map only what the text actually states onto these keys; omit a key rather than guess:',
    ...FIELD_KEYS.map((k) => `- ${k}`),
    '',
    'Rules: short plain-string values. fullName/firstName/lastName exactly as written.',
    'email, phone, location, linkedin, github, portfolio only when literally present.',
    'workAuth, sponsorshipNeeded, relocate, salary, notice, earliestStart,',
    'remotePreference, pronouns only when the text states them explicitly.',
    '',
    'Return one JSON object using ONLY keys from the list.',
  ].join('\n')
}

export async function runFactsExtract(runner: CodexRunner, cvText: string, opts: CallOpts): Promise<Record<string, string>> {
  const record = await runner.complete(buildFactsExtractPrompt(cvText), FactsExtractSchema, opts)
  const out: Record<string, string> = {}
  for (const k of FIELD_KEYS) {
    const v = (record as Record<string, string | undefined>)[k]
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  return out
}
