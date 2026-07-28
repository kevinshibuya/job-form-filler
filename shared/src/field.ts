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
})
export type EnumField = z.infer<typeof EnumFieldSchema>

/** What the panel does with a resolved field. */
export const ResolutionTierSchema = z.enum(['auto', 'proposed', 'needs_input', 'skipped'])
export type ResolutionTier = z.infer<typeof ResolutionTierSchema>

export const ResolutionSourceSchema = z.enum([
  'profile', 'answer_bank', 'saved_answer', 'llm_key', 'llm_reuse', 'page',
])
export type ResolutionSource = z.infer<typeof ResolutionSourceSchema>

export const ResolutionSchema = z.object({
  handle: FieldHandleSchema,
  tier: ResolutionTierSchema,
  value: z.string().nullable(),
  source: ResolutionSourceSchema.nullable(),
  key: z.enum(FIELD_KEYS).nullable(),
  answerId: z.number().int().nullable(),
  /** Machine-ish trace shown in the panel, e.g. "recognizer:email". */
  reason: z.string(),
})
export type Resolution = z.infer<typeof ResolutionSchema>
