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

/** The synthetic reason foreign rows carry. FieldRow maps it to a hint; save.ts
 *  never sees it (the synthetic resolution lives only inside PanelRows). */
export const FOREIGN_REASON = 'other-frame'

export interface PanelRows {
  /** Elected-frame rows in document order (fid order IS document order within a
   *  frame) — tier becomes a badge, not a bucket (A9). */
  main: Row[]
  /** Non-elected-frame rows: synthetic needs_input resolution, manual Fill only. */
  foreign: Row[]
}

/**
 * A9: foreignness is DERIVED here from `field.frameId !== electedFrameId` — it
 * is never an EnumField property (zod would strip it) and never a host concern.
 * Foreign fields were excluded from resolve, so they have no real resolution;
 * the synthetic one is minted so they render. Elected-frame fields with no
 * resolution are still dropped, never guessed.
 */
export function buildRows(fields: EnumField[], resolutions: Resolution[], electedFrameId: number | null): PanelRows {
  const byRef = new Map(resolutions.map((r) => [refOf(r.handle), r]))
  const main: Row[] = []
  const foreign: Row[] = []
  for (const field of fields) {
    const ref = refOf(field)
    if (electedFrameId !== null && field.frameId !== electedFrameId) {
      foreign.push({
        ref, field,
        resolution: {
          handle: { frameId: field.frameId, fid: field.fid, epoch: field.epoch },
          // A demographic field keeps the SKIPPED affordance even outside the
          // elected frame: FieldRow's skipped early-return renders it read-only,
          // which is the visible half of demographic skipping. Foreign fields
          // never reach the host, so nothing else would mark them.
          tier: field.demographic ? 'skipped' as const : 'needs_input' as const,
          value: null, source: null, key: null, answerId: null,
          reason: field.demographic ? 'eeo' : FOREIGN_REASON,
        },
      })
      continue
    }
    const resolution = byRef.get(ref)
    if (resolution === undefined) continue
    main.push({ ref, field, resolution })
  }
  return { main, foreign }
}
