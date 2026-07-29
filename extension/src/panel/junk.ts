import type { EnumField } from '@jff/shared'
import { scoreResumeField } from './resumeTarget'

/**
 * A5 panel-layer junk filter. The content script enumerates and fid-stamps
 * EVERYTHING (snapshot behavior and fid numbering must stay identical across
 * re-scans); the PANEL decides what is worth resolving, filling and rendering.
 *
 * Kept despite visible:false —
 * - kind 'choice': the backing input is hidden BY DESIGN (A3 re-kinded it);
 * - hidden checkboxes/radios with a resolvable label: styled-control recipe;
 * - file inputs with a resolvable label: dropzone-hidden real inputs
 *   (Greenhouse). The blanket file exemption is deliberately GONE — an
 *   unlabelled hidden file input (Ashby's autofill pane) is junk. Slice 2 (A8)
 *   extends this clause with the resume-targeting score.
 */
export function keepField(f: EnumField): boolean {
  if (f.visible) return true
  if (f.kind === 'choice') return true
  if ((f.kind === 'checkbox' || f.kind === 'radiogroup') && f.label !== null) return true
  // A8 seam (this is the extension plan 1 documented): a hidden file input
  // earns its keep by a resolvable label OR by scoring positively on the
  // resume scorer (name/id/accept/required signals). Still no blanket keep —
  // an unlabelled, signal-less hidden file input (the autofill pane) is junk.
  if (f.kind === 'file' && (f.label !== null || scoreResumeField(f) > 0)) return true
  return false
}

export function dropJunk(fields: EnumField[]): EnumField[] {
  return fields.filter(keepField)
}
