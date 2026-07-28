import type { EnumField, FieldHandle, Resolution, ResolutionTier } from '@jff/shared'

export interface Row {
  ref: string
  field: EnumField
  resolution: Resolution
}

export function refOf(h: Pick<FieldHandle, 'frameId' | 'fid'>): string {
  return `${h.frameId}:${h.fid}`
}

export const SOURCE_BADGE: Record<NonNullable<Resolution['source']>, string> = {
  profile: 'profile',
  answer_bank: 'saved fact',
  saved_answer: 'saved answer',
  llm_key: 'AI match',
  llm_reuse: 'AI reuse',
  page: 'already on page',
}

/** Bucket every field by tier. A field with no resolution is dropped, never guessed. */
export function groupRows(fields: EnumField[], resolutions: Resolution[]): Record<ResolutionTier, Row[]> {
  const byRef = new Map(resolutions.map((r) => [refOf(r.handle), r]))
  const out: Record<ResolutionTier, Row[]> = { auto: [], proposed: [], needs_input: [], skipped: [] }
  for (const field of fields) {
    const ref = refOf(field)
    const resolution = byRef.get(ref)
    if (resolution === undefined) continue
    out[resolution.tier].push({ ref, field, resolution })
  }
  return out
}
