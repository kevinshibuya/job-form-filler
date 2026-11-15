import type { EnumField, FieldHandle, Resolution } from '@jff/shared'

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

/** The synthetic reason foreign rows carry. FieldRow maps it to a hint; save.ts
 *  never sees it (the synthetic resolution lives only inside PanelRows). */
export const FOREIGN_REASON = 'other-frame'

/** One entry of the elected frame's list: a row with its Resolution, or a
 *  Field still being matched, which has none. */
export type ListedRow =
  | { kind: 'row'; row: Row }
  | { kind: 'waiting'; ref: string; field: EnumField }

export interface PanelRows {
  /** Elected-frame rows in document order (fid order IS document order within a
   *  frame) — tier becomes a badge, not a bucket (A9). Only rows that carry a
   *  Resolution: every action reads from here, so a waiting Field has none. */
  main: Row[]
  /** `main` with the waiting Fields in their places, in document order: what
   *  the panel lists. */
  listed: ListedRow[]
  /** Non-elected-frame rows: synthetic needs_input resolution, manual Fill only. */
  foreign: Row[]
}

/**
 * A9: foreignness is DERIVED here from `field.frameId !== electedFrameId` — it
 * is never an EnumField property (zod would strip it) and never a host concern.
 * Foreign fields were excluded from resolve, so they have no real resolution;
 * the synthetic one is minted so they render. Elected-frame fields with no
 * resolution are still dropped, never guessed, unless they are `waiting` on
 * Mapping: those are listed as waiting, with no Resolution.
 */
export function buildRows(
  fields: EnumField[], resolutions: Resolution[], electedFrameId: number | null, waiting: readonly string[] = [],
): PanelRows {
  const byRef = new Map(resolutions.map((r) => [refOf(r.handle), r]))
  const waitingRefs = new Set(waiting)
  const main: Row[] = []
  const listed: ListedRow[] = []
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
    if (resolution === undefined) {
      if (waitingRefs.has(ref)) listed.push({ kind: 'waiting', ref, field })
      continue
    }
    const row = { ref, field, resolution }
    main.push(row)
    listed.push({ kind: 'row', row })
  }
  return { main, listed, foreign }
}
