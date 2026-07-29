import type { EnumField } from '@jff/shared'

/** A8's label/name signal. `currícul` covers currículo and curricular forms. */
export const RESUME_LABEL_RE = /resume|cv|currícul/i
const ACCEPT_RE = /pdf|doc/i

/**
 * A8: how resume-like is this file field? +3 label match, +2 name/id match,
 * +1 accept mentions pdf/doc, +2 required. The Ashby autofill-pane input
 * (unlabelled, optional, no signal) scores 0 and can never be targeted.
 */
export function scoreResumeField(f: EnumField): number {
  if (f.kind !== 'file') return 0
  let score = 0
  if (f.label !== null && RESUME_LABEL_RE.test(f.label)) score += 3
  if ((f.name !== null && RESUME_LABEL_RE.test(f.name)) || (f.idAttr !== null && RESUME_LABEL_RE.test(f.idAttr))) score += 2
  if (f.accept !== undefined && ACCEPT_RE.test(f.accept)) score += 1
  if (f.required) score += 2
  return score
}

/** Highest POSITIVE score wins; ties go to document order. Zero positive
 *  candidates -> null: no upload, and the panel notes it (A9). */
export function pickResumeTarget(fields: EnumField[]): EnumField | null {
  let best: EnumField | null = null
  let bestScore = 0
  for (const f of fields) {
    const s = scoreResumeField(f)
    if (s > bestScore) { best = f; bestScore = s }
  }
  return best
}
