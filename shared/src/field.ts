import { z } from 'zod'
import { FIELD_KEYS } from './keys.js'

/**
 * A field is addressed by the triple {frameId, fid, epoch}.
 * - frameId  : stamped by the service worker from `sender.frameId` (the content
 *              script cannot know its own frame id).
 * - fid      : per-frame counter written to the element as `data-jff-fid`.
 * - epoch    : issued by the PANEL, one per scan, and broadcast into every frame.
 *              A message whose epoch differs from the frame's current epoch is
 *              rejected — old handles can never touch re-rendered DOM.
 */
export const FieldHandleSchema = z.object({
  frameId: z.number().int(),
  fid: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
})
export type FieldHandle = z.infer<typeof FieldHandleSchema>

export const WidgetKindSchema = z.enum([
  'text', 'textarea', 'select', 'combobox', 'radiogroup', 'checkbox', 'file', 'choice',
  // Checkboxes that share a name or a group label: one Field whose Options are
  // the boxes' labels and whose Value is a set of them (a multi-choice Control).
  'checkboxgroup',
])
export type WidgetKind = z.infer<typeof WidgetKindSchema>

export const EnumFieldSchema = FieldHandleSchema.extend({
  label: z.string().nullable(),
  name: z.string().nullable(),
  idAttr: z.string().nullable(),
  kind: WidgetKindSchema,
  options: z.array(z.string()),
  required: z.boolean(),
  visible: z.boolean(),
  /** Value already on the page (e.g. written by the ATS resume auto-parse). */
  currentValue: z.string().nullable(),
  demographic: z.boolean(),
  /** A4: page-provided helper text under the question label — wrapper-scoped,
   *  whitespace-normalized textContent, capped at 500 chars in the enumerator.
   *  Optional: a stale content script simply omits it. */
  description: z.string().optional(),
  /** A8: the file input's raw `accept` attribute, captured so the panel's
   *  resume scorer can read it (+1 for pdf/doc). File kinds only; optional so
   *  a stale content script simply omits it. */
  accept: z.string().optional(),
})
export type EnumField = z.infer<typeof EnumFieldSchema>

/**
 * A lone checkbox is a Consent checkbox: the user agrees to or acknowledges
 * something by it. Resolution always leaves it Needs input, and Save answers
 * never stores it, so a consent is never recalled onto another form.
 * A checkbox drawn as yes/no buttons enumerates as `choice`, not here.
 */
export function isConsentCheckbox(field: Pick<EnumField, 'kind'>): boolean {
  return field.kind === 'checkbox'
}

/** A checkbox group: one Field, a multi-choice Control, its Options the boxes' labels. */
export function isCheckboxGroup(field: Pick<EnumField, 'kind'>): boolean {
  return field.kind === 'checkboxgroup'
}

/**
 * The Value of a multi-choice Control is a set of Option labels. Wherever it
 * travels as text, the set is its labels joined by a newline, in page order.
 */
export function optionSetValue(labels: readonly string[]): string {
  return labels.join('\n')
}

/** The Option labels a Value written as text holds, blank lines dropped. */
export function optionSetLabels(value: string): string[] {
  return value.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
}

/** What the panel does with a resolved field. */
export const ResolutionTierSchema = z.enum(['auto', 'proposed', 'needs_input', 'skipped'])
export type ResolutionTier = z.infer<typeof ResolutionTierSchema>

export const ResolutionSourceSchema = z.enum([
  'profile', 'answer_bank', 'saved_answer', 'llm_key', 'llm_reuse', 'page',
])
export type ResolutionSource = z.infer<typeof ResolutionSourceSchema>

/**
 * What Mapping says a Field it matched to nothing asks for. A Prose Field asks
 * for opinion, motivation or narrative, and is the only kind Generation drafts.
 * A Personal-fact Field asks something true or false about the user, who
 * answers it.
 */
export const FieldClassSchema = z.enum(['prose', 'personal_fact'])
export type FieldClass = z.infer<typeof FieldClassSchema>

export const ResolutionSchema = z.object({
  handle: FieldHandleSchema,
  tier: ResolutionTierSchema,
  value: z.string().nullable(),
  source: ResolutionSourceSchema.nullable(),
  key: z.enum(FIELD_KEYS).nullable(),
  answerId: z.number().int().nullable(),
  /** Machine-ish trace shown in the panel, e.g. "recognizer:email". */
  reason: z.string(),
  /**
   * Set only on a Field Mapping matched to neither a Known key nor a Saved
   * answer. Absent everywhere else, and an absent label is read as
   * `personal_fact`: a Field nobody labelled prose is the user's to answer.
   */
  fieldClass: FieldClassSchema.optional(),
  /**
   * The words a page may use for the Value, in English and Portuguese, from
   * the rule table (ruleTable.ts). Fill picks the one Option equal to the Value
   * or to one of these. Absent when the Value has none: after ticket #26 only
   * a `country` Value carries them.
   */
  candidates: z.array(z.string()).optional(),
})
export type Resolution = z.infer<typeof ResolutionSchema>
