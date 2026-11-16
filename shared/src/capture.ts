import { z } from 'zod'
import { EnumFieldSchema, ResolutionSchema, type EnumField, type Resolution } from './field.js'
import { JobTextSourceSchema } from './jobText.js'

/**
 * A Capture (spec #41): a cleaned copy of a page and what the Scan decided,
 * saved on the user's machine for the maintainer to turn into a fixture.
 *
 * What may travel is decided here, once, for the Side panel that builds the
 * request and the Native host that refuses one that carries more.
 */

/** The longest cleaned page a Capture keeps, in characters, cut mark included. */
export const CAPTURE_MAX_CHARS = 2_000_000

/** What ends a cleaned page that was cut to CAPTURE_MAX_CHARS. */
export const CAPTURE_CUT_MARK = '<!-- job-form-filler: the page was cut here at 2,000,000 characters -->'

/**
 * The only keys of a Resolution a Capture keeps: which Field it answers, its
 * outcome, its source, its Known key and its reason. The Value, the phone's
 * parts, the city's parts, the candidate wordings and any key added later are
 * left out, so nothing derived from a stored Value reaches a Capture.
 */
export const CAPTURE_RESOLUTION_KEYS = ['handle', 'tier', 'source', 'key', 'reason'] as const

/** A Resolution as a Capture holds it. `passthrough` so the Native host sees,
 *  and refuses, a key the list does not name instead of zod dropping it. */
export const CaptureResolutionSchema = ResolutionSchema.pick({ handle: true, tier: true, source: true, key: true, reason: true }).passthrough()
export type CaptureResolution = Pick<Resolution, typeof CAPTURE_RESOLUTION_KEYS[number]>

/** The election as a Capture holds it: the address without its query. */
export const CaptureElectionSchema = z.object({ frameId: z.number().int(), score: z.number(), url: z.string().nullable() })

/** One frame's report as a Capture holds it: the address without its query. */
export const CaptureFrameReportSchema = z.object({
  frameId: z.number().int(),
  url: z.string().nullable(),
  fields: z.number().int().nullable(),
  error: z.string().nullable(),
})

/** The cleaned page the page script hands back for a Capture. */
export const CapturedPageSchema = z.object({
  html: z.string().max(CAPTURE_MAX_CHARS),
  /** True when the page was cut to CAPTURE_MAX_CHARS and ends with the cut mark. */
  cut: z.boolean(),
})
export type CapturedPage = z.infer<typeof CapturedPageSchema>

/**
 * `capture.save`. Every Field goes without its current Value and every
 * Resolution with the five kept keys only; the Native host refuses one that
 * does not. Every address goes without its query.
 */
export const CaptureSaveParamsSchema = z.object({
  page: CapturedPageSchema,
  /** The Scan's ATS (an `AtsOrGeneric`). */
  ats: z.string().min(1).max(64),
  /** The tab's address, without its query. */
  url: z.string(),
  fields: z.array(EnumFieldSchema),
  resolutions: z.array(CaptureResolutionSchema),
  election: CaptureElectionSchema.nullable(),
  frameReports: z.array(CaptureFrameReportSchema),
  /** Where the Session's Job posting text came from. Absent when the Session
   *  was kept before the source was. */
  jobTextSource: JobTextSourceSchema.optional(),
})
export type CaptureSaveParams = z.infer<typeof CaptureSaveParamsSchema>

/** The reply to `capture.save`: where the Capture was written. */
export const CaptureSaveResultSchema = z.object({ path: z.string().min(1) })
export type CaptureSaveResult = z.infer<typeof CaptureSaveResultSchema>

/** A Field as a Capture holds it: without its current Value. */
export function captureField(field: EnumField): EnumField {
  return { ...field, currentValue: null }
}

/** A Resolution as a Capture holds it: the five kept keys and nothing else. */
export function captureResolution(resolution: Resolution): CaptureResolution {
  const { handle, tier, source, key, reason } = resolution
  return { handle, tier, source, key, reason }
}

/** An address without its query, and without its fragment, which can carry a
 *  token as well. A string that is not an absolute address is kept up to the
 *  first `?` or `#`. */
export function withoutQuery(url: string): string
export function withoutQuery(url: string | null): string | null
export function withoutQuery(url: string | null): string | null {
  if (url === null) return null
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    return url.replace(/[?#].*$/s, '')
  }
}

/** Why the Native host refuses a Capture before writing anything, or null. */
export function captureRefusal(params: Pick<CaptureSaveParams, 'fields' | 'resolutions'>): string | null {
  const valued = params.fields.filter((f) => f.currentValue !== null)
  if (valued.length > 0) return `${valued.length} Field(s) carry a current Value; a Capture holds none.`
  const kept = new Set<string>(CAPTURE_RESOLUTION_KEYS)
  const extra = new Set(params.resolutions.flatMap((r) => Object.keys(r).filter((k) => !kept.has(k))))
  if (extra.size > 0) return `a Resolution carries ${[...extra].sort().join(', ')}; a Capture keeps only ${CAPTURE_RESOLUTION_KEYS.join(', ')}.`
  return null
}
