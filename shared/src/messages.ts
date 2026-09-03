import { z } from 'zod'
import { EnumFieldSchema, FieldHandleSchema, ResolutionSchema } from './field.js'
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

export const HostRequestSchema = z.discriminatedUnion('method', [
  z.object({ requestId: z.string().min(1), method: z.literal('selfCheck'), params: z.object({}).passthrough() }),
  z.object({ requestId: z.string().min(1), method: z.literal('profile.get'), params: z.object({}).passthrough() }),
  z.object({ requestId: z.string().min(1), method: z.literal('profile.set'), params: z.object({ values: z.record(z.string(), z.string()) }) }),
  z.object({ requestId: z.string().min(1), method: z.literal('answerBank.get'), params: z.object({}).passthrough() }),
  z.object({ requestId: z.string().min(1), method: z.literal('answerBank.set'), params: z.object({ values: z.record(z.string(), z.string()) }) }),
  z.object({
    requestId: z.string().min(1), method: z.literal('resolve'),
    params: z.object({
      epoch: z.number().int(),
      url: z.string(),
      hostname: z.string(),
      company: z.string().nullable(),
      jobText: z.string(),
      fields: z.array(EnumFieldSchema),
    }),
  }),
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

// There is deliberately NO customQuestions list here: the panel offers [Generate]
// on EVERY needs-input row (spec, "Needs input — each with a [Generate with AI]
// button"), so a separate list would be dead payload. The reason string `custom`
// marks the rows the LLM classified as free-text.
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

/* ------------------------------------------------ panel <-> content script */

export const ContentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('JFF_PROBE') }),
  z.object({ type: z.literal('JFF_SCAN'), epoch: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('JFF_FILL'), epoch: z.number().int().nonnegative(),
    fills: z.array(z.object({ handle: FieldHandleSchema, value: z.string() })),
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
  z.object({
    // A6: open the listed comboboxes, read their mounted options, close and
    // restore. ELECTED-frame-only is the PANEL's decision (it addresses the
    // frame directly); the content script enforces only the epoch gate.
    type: z.literal('JFF_HARVEST'),
    epoch: z.number().int().nonnegative(),
    fids: z.array(z.number().int().nonnegative()),
  }),
])
export type ContentMessage = z.infer<typeof ContentMessageSchema>

// Both schemas below have a REAL runtime consumer: the content script `safeParse`s
// its own JFF_SCAN / JFF_FILL reply before returning it (Task 14 Step 5, Task 15
// Step 5). Validating our own output is the cheapest guard against enumerator or
// filler drift shipping a malformed field into the host's `resolve` call, where it
// would fail as an opaque bad_request instead of naming the offending frame.
export const ScanResultSchema = z.object({
  epoch: z.number().int(),
  fields: z.array(EnumFieldSchema),
  unreachableWidgets: z.number().int().nonnegative(),
  activeCaptcha: z.boolean(),
})
export type ScanResult = z.infer<typeof ScanResultSchema>

export const FillReportSchema = z.object({
  epoch: z.number().int(),
  /** B1c: `committed` carries the page-accepted canonical text when it differs
   *  from the requested value ('bra' legitimately commits 'Brazil'), else null.
   *  The panel canonicalizes the row value from it. */
  filled: z.array(z.object({ handle: FieldHandleSchema, committed: z.string().nullable() })),
  failed: z.array(z.object({ handle: FieldHandleSchema, reason: z.string() })),
})
export type FillReport = z.infer<typeof FillReportSchema>

export const STALE_EPOCH = 'stale_epoch' as const
