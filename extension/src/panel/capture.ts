import {
  captureField, captureResolution, withoutQuery,
  type CapturedPage, type CaptureSaveParams, type EnumField, type JobTextSource, type Resolution,
} from '@jff/shared'
import type { ElectionOutcome, FrameReport } from './scan'
import { refOf } from './group'

/**
 * A Capture as the Side panel builds it (spec #41). The page arrives cleaned
 * from the page script; everything the Scan decided is stripped here of what
 * a Capture never holds: every Field's current Value, every Resolution key
 * but five, and every address's query.
 */

/** What the Side panel knows of a Scan, as the Session keeps it. */
export interface ScanRecord {
  ats: string
  fields: EnumField[]
  resolutions: Resolution[]
  election: ElectionOutcome | null
  frameReports: FrameReport[]
  edits: Record<string, string>
  snapshot: Record<string, string>
  /** Where the Session's Job posting text came from; null when it was kept
   *  before the source was. */
  jobTextSource: JobTextSource | null
}

/** The frame a Capture asks for its page: the elected one, or the top frame. */
export function captureFrame(scan: Pick<ScanRecord, 'election'>): number {
  return scan.election?.frameId ?? 0
}

/**
 * The Values the Side panel knows for one frame's Fields, by fid: what the
 * page showed at the Scan, what was filled or typed, what the page committed.
 * They travel only to the page that already shows them, which blanks them
 * inside each Control's own widget.
 */
export function heldValues(scan: Pick<ScanRecord, 'fields' | 'resolutions' | 'edits' | 'snapshot'>, frameId: number): { fid: number; value: string }[] {
  const resolutionOf = new Map(scan.resolutions.map((r) => [refOf(r.handle), r]))
  const out: { fid: number; value: string }[] = []
  for (const field of scan.fields) {
    if (field.frameId !== frameId) continue
    const ref = refOf(field)
    const values = new Set([field.currentValue, resolutionOf.get(ref)?.value, scan.edits[ref], scan.snapshot[ref]])
    for (const value of values) if (typeof value === 'string' && value.trim() !== '') out.push({ fid: field.fid, value })
  }
  return out
}

/** The `capture.save` request: the cleaned page beside what the Scan decided,
 *  holding no Value and no address's query. */
export function captureRequest(page: CapturedPage, scan: ScanRecord, url: string): CaptureSaveParams {
  return {
    page,
    ats: scan.ats,
    url: withoutQuery(url),
    fields: scan.fields.map(captureField),
    resolutions: scan.resolutions.map(captureResolution),
    election: scan.election === null ? null : { ...scan.election, url: withoutQuery(scan.election.url) },
    frameReports: scan.frameReports.map((r) => ({ ...r, url: withoutQuery(r.url) })),
    ...(scan.jobTextSource === null ? {} : { jobTextSource: scan.jobTextSource }),
  }
}
