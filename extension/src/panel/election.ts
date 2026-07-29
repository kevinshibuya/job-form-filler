import type { EnumField } from '@jff/shared'

export interface FrameScore {
  frameId: number
  fields: number
  required: number
  hasFile: boolean
  score: number
}

export interface Election {
  frameId: number
  score: number
  /** Every frame's breakdown — the "Other page fields" header and diagnostics
   *  can explain a mis-election instead of hiding it. */
  scores: FrameScore[]
}

/**
 * A7: which frame is THE application? By signal, never by frame position
 * (Greenhouse/Lever render in the top document, Ashby in an iframe).
 * Score = fields + 3×required + 5×(has file input). Deliberately NO jobText
 * term: jobText is requested from frame 0 only and skipped entirely when the
 * user pasted text, so it cannot be a fair signal (spec'd out).
 * Tie → most fields → lowest frameId.
 */
export function electFrame(fields: EnumField[]): Election | null {
  const byFrame = new Map<number, FrameScore>()
  for (const f of fields) {
    const s = byFrame.get(f.frameId) ?? { frameId: f.frameId, fields: 0, required: 0, hasFile: false, score: 0 }
    s.fields++
    if (f.required) s.required++
    if (f.kind === 'file') s.hasFile = true
    byFrame.set(f.frameId, s)
  }
  const scores = Array.from(byFrame.values())
  if (scores.length === 0) return null
  for (const s of scores) s.score = s.fields + 3 * s.required + (s.hasFile ? 5 : 0)
  scores.sort((a, b) => b.score - a.score || b.fields - a.fields || a.frameId - b.frameId)
  const winner = scores[0]!
  return { frameId: winner.frameId, score: winner.score, scores }
}
