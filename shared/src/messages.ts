import { z } from 'zod'
import { CityPartsSchema, EnumFieldSchema, FieldHandleSchema, PhonePartsSchema, ResolutionSchema } from './field.js'
import { FIELD_KEYS } from './keys.js'

// Re-exported so `./messages.js` alone carries the field-identity types it
// builds its request/response schemas from (see shared/src/messages.test.ts).
export { EnumFieldSchema, FieldHandleSchema, ResolutionSchema } from './field.js'

/* ---------------------------------------------------------------- host RPC */

export const HOST_ERROR_KINDS = [
  'not_installed', 'not_authed', 'rate_limit', 'timeout',
  'process', 'invalid_output', 'db', 'bad_request', 'unreachable',
] as const
export const HostErrorKindSchema = z.enum(HOST_ERROR_KINDS)
export type HostErrorKind = z.infer<typeof HostErrorKindSchema>

export const SavedQaSchema = z.object({
  id: z.number().int(),
  questionRaw: z.string(),
  answer: z.string(),
  language: z.enum(['en', 'pt']),
  reusability: z.enum(['reusable', 'company_specific']),
})
export type SavedQa = z.infer<typeof SavedQaSchema>

export const SaveItemSchema = z.object({
  handle: FieldHandleSchema,
  questionRaw: z.string(),
  answer: z.string(),
  reusability: z.enum(['reusable', 'company_specific']),
  // Facts never travel through Save answers: they reach profile/answer_bank
  // only through "Save to profile" and the Profile editor. The property stays
  // on the wire so an older panel that still sends a key fails validation
  // loudly instead of being silently ignored.
  fieldKey: z.null(),
})
export type SaveItem = z.infer<typeof SaveItemSchema>

/** What every Resolution request carries: the Scan's context and its Fields. */
export const ResolveParamsSchema = z.object({
  epoch: z.number().int(),
  url: z.string(),
  hostname: z.string(),
  company: z.string().nullable(),
  jobText: z.string(),
  fields: z.array(EnumFieldSchema),
})
export type ResolveParams = z.infer<typeof ResolveParamsSchema>

export const OptionPickParamsSchema = z.object({
  label: z.string(),
  value: z.string().min(1),
  options: z.array(z.string()).min(1),
})
export type OptionPickParams = z.infer<typeof OptionPickParamsSchema>

/**
 * The reply to `option.pick`: the position (from 0) of one of the Options the
 * request carried, or null for none. There is no text property, and zod strips
 * unknown keys: the model can never write a Value (ADR 0006, ADR 0008).
 */
export const OptionPickResultSchema = z.object({
  position: z.number().int().nonnegative().nullable(),
})
export type OptionPickResult = z.infer<typeof OptionPickResultSchema>

/**
 * `wording.learn` (ticket #35): the user accepted, or picked after a miss, the
 * Option `wording` for a Field answered from the Known key `key`, and
 * `value` is the Value the Option stood for: the key's Value as the
 * Resolution gave it, or the yes or no of a derived answer.
 */
export const LearnWordingParamsSchema = z.object({
  key: z.enum(FIELD_KEYS),
  value: z.string().trim().min(1),
  wording: z.string().trim().min(1),
})
export type LearnWordingParams = z.infer<typeof LearnWordingParamsSchema>

/** The reply to `wording.learn`: false when the Value is not one a wording can be learned for. */
export const LearnWordingResultSchema = z.object({ learned: z.boolean() })
export type LearnWordingResult = z.infer<typeof LearnWordingResultSchema>

export const HostRequestSchema = z.discriminatedUnion('method', [
  z.object({ requestId: z.string().min(1), method: z.literal('selfCheck'), params: z.object({}).passthrough() }),
  z.object({ requestId: z.string().min(1), method: z.literal('profile.get'), params: z.object({}).passthrough() }),
  z.object({ requestId: z.string().min(1), method: z.literal('profile.set'), params: z.object({ values: z.record(z.string(), z.string()) }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('answerBank.get'), params: z.object({}).passthrough() }),
  z.object({ requestId: z.string().min(1), method: z.literal('answerBank.set'), params: z.object({ values: z.record(z.string(), z.string()) }) }),
  // Resolution in two requests. `resolve.first` runs no model and answers every
  // Field that needs none; `resolve.mapping` carries the pending Fields
  // themselves and runs Mapping on them. The host keeps no state between the two.
  z.object({ requestId: z.string().min(1), method: z.literal('resolve.first'), params: ResolveParamsSchema }),
  z.object({ requestId: z.string().min(1), method: z.literal('resolve.mapping'), params: ResolveParamsSchema }),
  z.object({
    requestId: z.string().min(1), method: z.literal('generate'),
    params: z.object({
      handle: FieldHandleSchema,
      questionRaw: z.string(),
      description: z.string().optional(),
      jobText: z.string(),
      company: z.string().nullable(),
      // B2b: extracted resume TEXT, trusted candidate-authored context. The raw
      // file still never crosses native messaging (user decision 2026-07-29).
      cvText: z.string().optional(),
    }),
  }),
  z.object({
    requestId: z.string().min(1), method: z.literal('facts.extract'),
    // B6: map CV text onto the closed FIELD_KEYS set (host-side prompt).
    params: z.object({ cvText: z.string().min(1) }),
  }),
  z.object({
    requestId: z.string().min(1), method: z.literal('save'),
    params: z.object({
      url: z.string(),
      company: z.string().nullable(),
      items: z.array(SaveItemSchema),
      generatedCount: z.number().int().nonnegative(),
    }),
  }),
  // The model pick (ADR 0008), made at Fill time after a miss: the Field's
  // label, the stored Value it was meant to fill, and the Options the Fill
  // read. Nothing else from the Profile travels with it.
  z.object({ requestId: z.string().min(1), method: z.literal('option.pick'), params: OptionPickParamsSchema }),
  // A Learned wording: an Option the user accepted for a keyed Field.
  z.object({ requestId: z.string().min(1), method: z.literal('wording.learn'), params: LearnWordingParamsSchema }),
  z.object({ requestId: z.string().min(1), method: z.literal('selector.get'), params: z.object({ hostname: z.string(), purpose: z.literal('job_description') }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('selector.save'), params: z.object({ hostname: z.string(), purpose: z.literal('job_description'), selector: z.string() }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('mapping.confirm'), params: z.object({ label: z.string(), fieldKey: z.enum(FIELD_KEYS) }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('qa.list'), params: z.object({ page: z.number().int().nonnegative() }) }),
  z.object({
    requestId: z.string().min(1), method: z.literal('applied.mark'),
    // A2: url is the session's captured START url; jobTitle from tab.title, nullable.
    params: z.object({ url: z.string().min(1), company: z.string().nullable(), jobTitle: z.string().nullable() }),
  }),
  z.object({ requestId: z.string().min(1), method: z.literal('applied.check'), params: z.object({ url: z.string().min(1) }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('applied.list'), params: z.object({}).passthrough() }),
])
export type HostRequest = z.infer<typeof HostRequestSchema>
export type HostMethod = HostRequest['method']

export const SelfCheckSchema = z.object({
  node: z.object({ ok: z.boolean(), version: z.string() }),
  claude: z.object({ ok: z.boolean(), path: z.string(), detail: z.string() }),
  auth: z.object({ ok: z.boolean(), detail: z.string() }),
  codex: z.object({ ok: z.boolean(), path: z.string(), detail: z.string() }),
  codexAuth: z.object({ ok: z.boolean(), detail: z.string() }),
  db: z.object({ ok: z.boolean(), path: z.string() }),
})
export type SelfCheck = z.infer<typeof SelfCheckSchema>

export const HostResponseSchema = z.union([
  z.object({ requestId: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    requestId: z.string(), ok: z.literal(false),
    error: z.object({ kind: HostErrorKindSchema, message: z.string() }),
  }),
])
export type HostResponse = z.infer<typeof HostResponseSchema>

/** Any response that can grow uses this envelope; the panel loops until done. */
export const PageEnvelopeSchema = z.object({
  page: z.number().int().nonnegative(),
  done: z.boolean(),
  items: z.array(z.unknown()),
  /** Items dropped because they alone exceed the byte budget (see host/src/chunk.ts). */
  omitted: z.number().int().nonnegative(),
})

// There is deliberately NO customQuestions list here: each Resolution Mapping
// matched to nothing carries its own `fieldClass`, and the panel offers
// [Generate] only on a Needs input Prose Field on a text Control.
export const ResolveResultSchema = z.object({
  epoch: z.number().int(),
  resolutions: z.array(ResolutionSchema),
  /**
   * Set when the batched mapping call failed. Every unresolved field is already
   * needs-input; this only tells the panel WHICH banner to show.
   */
  llmError: z.object({ kind: HostErrorKindSchema, message: z.string() }).nullable(),
})
export type ResolveResult = z.infer<typeof ResolveResultSchema>

/**
 * The reply to `resolve.first`: a Resolution for every Field that needs no
 * model, and the handles of the Fields left for `resolve.mapping`. Every Field
 * of the request is in exactly one of the two lists.
 */
export const ResolveFirstResultSchema = z.object({
  epoch: z.number().int(),
  resolutions: z.array(ResolutionSchema),
  pending: z.array(FieldHandleSchema),
})
export type ResolveFirstResult = z.infer<typeof ResolveFirstResultSchema>

/** The reply to `resolve.mapping`: a Resolution for every Field it carries. */
export const ResolveMappingResultSchema = ResolveResultSchema
export type ResolveMappingResult = ResolveResult

/* ------------------------------------------------ panel <-> content script */

export const ContentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('JFF_PROBE') }),
  z.object({ type: z.literal('JFF_SCAN'), epoch: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('JFF_FILL'), epoch: z.number().int().nonnegative(),
    // `candidates`: the candidate words of the row's Value (Resolution.candidates).
    // Absent once the user edited the Value: an edited Value matches by its own text.
    // `phone`: the parts of a phone Value (Resolution.phone), on the same terms.
    // `city`: the stored country's names beside a city (Resolution.city), likewise.
    // No `value`: a read (ticket #34). The Fill reads the Control's Options,
    // changes nothing on the page, and reports them as a miss does, with the
    // reason OPTIONS_READ.
    fills: z.array(z.object({
      handle: FieldHandleSchema, value: z.string().optional(), candidates: z.array(z.string()).optional(),
      phone: PhonePartsSchema.optional(), city: CityPartsSchema.optional(),
    })),
  }),
  z.object({ type: z.literal('JFF_SNAPSHOT'), epoch: z.number().int().nonnegative() }),
  z.object({ type: z.literal('JFF_PICK'), epoch: z.number().int().nonnegative() }),
  z.object({ type: z.literal('JFF_JOBTEXT'), epoch: z.number().int().nonnegative(), selector: z.string().nullable() }),
  // A3: the panel's submission-detection needs the page's VISIBLE text after a
  // wizard-step re-scan; jobText heuristics answer a different question.
  z.object({ type: z.literal('JFF_PAGETEXT'), epoch: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('JFF_FILL_RESUME'),
    epoch: z.number().int().nonnegative(),
    handle: FieldHandleSchema,
    // The resume travels as base64 because chrome runtime messaging is JSON, not
    // structured clone: a File or Blob would not survive the trip.
    fileName: z.string(),
    mimeType: z.string(),
    dataBase64: z.string(),
  }),
])
export type ContentMessage = z.infer<typeof ContentMessageSchema>

// Both schemas below have a REAL runtime consumer: the content script `safeParse`s
// its own JFF_SCAN / JFF_FILL reply before returning it (Task 14 Step 5, Task 15
// Step 5). Validating our own output is the cheapest guard against enumerator or
// filler drift shipping a malformed field into the host's Resolution requests, where it
// would fail as an opaque bad_request instead of naming the offending frame.
export const ScanResultSchema = z.object({
  epoch: z.number().int(),
  fields: z.array(EnumFieldSchema),
  unreachableWidgets: z.number().int().nonnegative(),
  activeCaptcha: z.boolean(),
  /** #37: the labels of upload groups that show an attached file in place of
   *  their file input, so the panel sends no second resume. Optional so a stale
   *  content script simply omits it, and an absent list reads as none. */
  attachedUploads: z.array(z.string()).optional(),
})
export type ScanResult = z.infer<typeof ScanResultSchema>

/**
 * The Options a Fill of a choice Control read on the page, on a hit and on a
 * miss (ADR 0009: a Scan opens no menu, so a dropdown's Options are first known
 * here). Absent on a text Control, and on a dropdown that showed none before
 * anything was typed into it.
 */
const FillOptionsSchema = z.array(z.string()).optional()

export const FillReportSchema = z.object({
  epoch: z.number().int(),
  /** B1c: `committed` carries the page-accepted canonical text when it differs
   *  from the requested value ('bra' legitimately commits 'Brazil'), else null.
   *  The panel canonicalizes the row value from it. */
  filled: z.array(z.object({ handle: FieldHandleSchema, committed: z.string().nullable(), options: FillOptionsSchema })),
  failed: z.array(z.object({ handle: FieldHandleSchema, reason: z.string(), options: FillOptionsSchema })),
})
export type FillReport = z.infer<typeof FillReportSchema>

export const STALE_EPOCH = 'stale_epoch' as const

/**
 * The reason a Fill entry sent with no Value reports: the Control's Options
 * were read and nothing on the page changed (ticket #34). The Options travel
 * with it, as on a miss, and are absent when the Control showed none.
 */
export const OPTIONS_READ = 'options-read' as const
