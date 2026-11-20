import { z } from 'zod'
import { FIELD_KEYS, FieldClassSchema, isFieldKey, type EnumField, type FieldClass, type FieldKey } from '@jff/shared'
import type { CallOpts } from './claudeCli.js'
import type { CodexRunner } from './codexCli.js'
import { CAPS, UNTRUSTED_PREAMBLE, fence } from './fence.js'

export interface MappingCandidate {
  id: number
  questionRaw: string
  answer: string
  language: 'en' | 'pt'
  reusability: 'reusable' | 'company_specific'
}

export interface MappingInput {
  fields: EnumField[]
  jobText: string
  company: string | null
  candidates: MappingCandidate[]
}

export function refOf(f: { frameId: number; fid: number }): string {
  return `${f.frameId}:${f.fid}`
}

/**
 * ANTI-FABRICATION INVARIANT, structural form.
 * There is NO `value` field in this schema, and zod strips unknown keys, so the
 * model CANNOT return answer text at all. It may only choose: a key from the
 * closed set, an id from the candidates we sent, or "custom". Every value that
 * reaches the page is substituted from SQLite by the waterfall.
 * `fieldClass` is a closed two-value label, not text: anything else the model
 * puts there, a sentence included, is caught to null on that entry alone.
 */
export const MappingEntrySchema = z.object({
  ref: z.string(),
  decision: z.enum(['known_key', 'reuse_answer', 'custom']),
  knownKey: z.string().nullable().default(null),
  answerId: z.number().int().nullable().default(null),
  fieldClass: FieldClassSchema.nullable().catch(null),
})
export const MappingResponseSchema = z.array(MappingEntrySchema)

export interface MappingDecision {
  decision: 'known_key' | 'reuse_answer' | 'custom'
  knownKey: FieldKey | null
  answerId: number | null
  /**
   * On a `custom` decision only: the label Mapping gave, or null when it gave
   * none that counts. The waterfall reads null as a Personal-fact Field.
   */
  fieldClass: FieldClass | null
}

const CUSTOM: MappingDecision = { decision: 'custom', knownKey: null, answerId: null, fieldClass: null }

export function buildMappingPrompt(input: MappingInput): string {
  const fieldLines = input.fields.slice(0, CAPS.fieldsPerCall).map((f) => {
    const opts = f.options.slice(0, CAPS.optionsPerField)
      .map((o) => fence('option', o, CAPS.option))
      .join('')
    const desc = f.description === undefined || f.description === ''
      ? ''
      : ` ${fence('field_description', f.description, CAPS.description)}`
    // A combobox is a CLOSED widget whose Options the Scan never reads (ADR
    // 0009): it lists only what the page mounted unopened, often nothing. The
    // model must pick from options when they fit but must not treat an absent
    // option as proof the answer is free-text.
    const kindNote = f.kind === 'combobox' ? ' (closed set; options may be partial)' : ''
    return `- ref=${refOf(f)} kind=${f.kind}${kindNote} required=${f.required} ${fence('field_label', f.label ?? '', CAPS.label)}${desc}${opts}`
  }).join('\n')

  const candidateLines = input.candidates.length === 0
    ? '(none stored yet)'
    : input.candidates.map((c) =>
        `- id=${c.id} ${fence('stored_question', c.questionRaw, CAPS.label)} ${fence('stored_answer', c.answer, CAPS.answer)}`,
      ).join('\n')

  return [
    'You classify job-application form fields. You do NOT write answers.',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    `Company: ${input.company === null ? '(unknown)' : fence('field_label', input.company, CAPS.label)}`,
    fence('job_post', input.jobText, CAPS.jobText),
    '',
    'Closed set of known factual keys (use these EXACT strings, nothing else):',
    FIELD_KEYS.join(', '),
    '',
    'Previously stored reusable answers you may point at by id:',
    candidateLines,
    '',
    'Fields to classify:',
    fieldLines,
    '',
    'For EVERY ref above return exactly one entry:',
    '- decision="known_key" with knownKey set, when the field asks for one of the known factual keys.',
    '  location is the one-line place for a free-text box; a field that asks for a city, a region',
    '  or a country takes city, region or country. A yes/no question about where the applicant',
    '  lives is not a place: it is custom.',
    '- decision="reuse_answer" with answerId set, when a stored answer above already answers this exact field.',
    '- decision="custom" for anything else. A custom entry also sets fieldClass:',
    '  - fieldClass="prose" when the field asks for opinion, motivation or narrative in free text,',
    '    such as why this role, a project you are proud of, or how you approach a problem.',
    '  - fieldClass="personal_fact" when the field asks something true or false about the applicant',
    '    that the known keys and stored answers do not cover, such as accommodation needs,',
    '    whether they have worked at the company before, a self-rating or a yes/no about their situation.',
    '  - When in doubt, use "personal_fact". Leave fieldClass null on known_key and reuse_answer entries.',
    '',
    'Hard rules:',
    '- Return one entry per ref: no missing refs, no extra refs, no duplicates.',
    '- knownKey MUST be from the closed list. answerId MUST be one of the ids listed.',
    '- Do not write, guess, translate or paraphrase any answer text. You only classify.',
    '- Reply with a bare JSON array of entries, [{"ref": ..., "decision": ..., "knownKey": ..., "answerId": ..., "fieldClass": ...}], not wrapped in an object.',
  ].join('\n')
}

/**
 * Structural enforcement. A response that does not round-trip 1:1 by ref makes the
 * WHOLE batch fail closed (empty map = every field becomes needs-input), because a
 * misaligned batch could otherwise put the right answer in the wrong box.
 * An individual out-of-set knownKey/answerId degrades that one field to `custom`.
 */
export function validateMappingResponse(
  raw: unknown,
  requestedRefs: string[],
  candidateIds: number[],
): Map<string, MappingDecision> {
  // A model may wrap the array as {"entries": [...]}, as Opus does: read through it.
  const entries = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'entries' in raw ? (raw as { entries: unknown }).entries : raw
  const parsed = MappingResponseSchema.safeParse(entries)
  if (!parsed.success) return new Map()
  if (parsed.data.length !== requestedRefs.length) return new Map()

  const wanted = new Set(requestedRefs)
  const ids = new Set(candidateIds)
  const out = new Map<string, MappingDecision>()

  for (const e of parsed.data) {
    if (!wanted.has(e.ref) || out.has(e.ref)) return new Map()
    if (e.decision === 'known_key') {
      out.set(e.ref, e.knownKey !== null && isFieldKey(e.knownKey)
        ? { decision: 'known_key', knownKey: e.knownKey, answerId: null, fieldClass: null }
        : CUSTOM)
    } else if (e.decision === 'reuse_answer') {
      out.set(e.ref, e.answerId !== null && ids.has(e.answerId)
        ? { decision: 'reuse_answer', knownKey: null, answerId: e.answerId, fieldClass: null }
        : CUSTOM)
    } else {
      out.set(e.ref, { ...CUSTOM, fieldClass: e.fieldClass })
    }
  }
  if (out.size !== requestedRefs.length) return new Map()
  return out
}

export async function runMapping(runner: CodexRunner, input: MappingInput, opts: CallOpts): Promise<Map<string, MappingDecision>> {
  const fields = input.fields.slice(0, CAPS.fieldsPerCall)
  if (fields.length === 0) return new Map()
  const refs = fields.map(refOf)
  const ids = input.candidates.map((c) => c.id)
  // Deliberately parse as `unknown` here: validateMappingResponse owns every
  // structural rule, so a schema failure and a rule failure take the same path.
  const raw = await runner.complete(buildMappingPrompt({ ...input, fields }), z.unknown(), opts)
  return validateMappingResponse(raw, refs, ids)
}
