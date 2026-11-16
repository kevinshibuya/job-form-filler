import type { EnumField } from '@jff/shared'

/** A8's label/name signal. `currícul` covers currículo and curricular forms. */
export const RESUME_LABEL_RE = /resume|cv|currícul/i
const ACCEPT_RE = /pdf|doc/i

/** #37: Greenhouse's cover-letter uploader (`cover_letter`, "Cover Letter"). */
const COVER_LETTER_RE = /cover[\s_-]*letter/i

function says(f: EnumField, re: RegExp): boolean {
  return [f.label, f.name, f.idAttr].some((s) => s !== null && re.test(s))
}

/**
 * The raw file signals, with no veto: +3 label match, +2 name/id match,
 * +1 accept mentions pdf/doc, +2 required. The junk filter keeps a hidden
 * file input on these, so a field the resume scorer refuses is still a row.
 */
export function fileSignalScore(f: EnumField): number {
  if (f.kind !== 'file') return 0
  let score = 0
  if (f.label !== null && RESUME_LABEL_RE.test(f.label)) score += 3
  if ((f.name !== null && RESUME_LABEL_RE.test(f.name)) || (f.idAttr !== null && RESUME_LABEL_RE.test(f.idAttr))) score += 2
  if (f.accept !== undefined && ACCEPT_RE.test(f.accept)) score += 1
  if (f.required) score += 2
  return score
}

/**
 * A8: how resume-like is this file field? Its file signals. The Ashby
 * autofill-pane input (unlabelled, optional, no signal) scores 0 and can never
 * be targeted.
 * #37: a cover-letter field that nothing calls a resume scores 0 whatever else
 * it carries: its accept alone made it the target once the page removed the
 * resume input. A combined uploader ("Resume / Cover Letter") still scores.
 */
export function scoreResumeField(f: EnumField): number {
  if (says(f, COVER_LETTER_RE) && !says(f, RESUME_LABEL_RE)) return 0
  return fileSignalScore(f)
}

/** #37: the page already shows a resume attached when one of the elected
 *  frame's attached uploads carries a resume label. */
export function resumeAttached(attachedUploads: readonly string[]): boolean {
  return attachedUploads.some((label) => RESUME_LABEL_RE.test(label))
}

/** Highest POSITIVE score wins; ties go to document order. Zero positive
 *  candidates -> null: no upload, and the panel notes it (A9). A resume the
 *  page already shows attached -> null too: no second resume (#37). */
export function pickResumeTarget(fields: EnumField[], attachedUploads: readonly string[]): EnumField | null {
  if (resumeAttached(attachedUploads)) return null
  let best: EnumField | null = null
  let bestScore = 0
  for (const f of fields) {
    const s = scoreResumeField(f)
    if (s > bestScore) { best = f; bestScore = s }
  }
  return best
}
