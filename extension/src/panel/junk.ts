import type { EnumField } from '@jff/shared'
import { fileSignalScore } from './resumeTarget'

/**
 * A5 panel-layer junk filter. The content script enumerates and fid-stamps
 * EVERYTHING (snapshot behavior and fid numbering must stay identical across
 * re-scans); the PANEL decides what is worth resolving, filling and rendering.
 *
 * Kept despite visible:false —
 * - kind 'choice': the backing input is hidden BY DESIGN (A3 re-kinded it);
 * - hidden checkboxes, checkbox groups and radios with a resolvable label:
 *   styled-control recipe;
 * - file inputs with a resolvable label: dropzone-hidden real inputs
 *   (Greenhouse). The blanket file exemption is deliberately GONE — an
 *   unlabelled hidden file input (Ashby's autofill pane) is junk. Slice 2 (A8)
 *   extends this clause with the resume-targeting score.
 */
export function keepField(f: EnumField): boolean {
  if (f.visible) return true
  if (f.kind === 'choice') return true
  if ((f.kind === 'checkbox' || f.kind === 'checkboxgroup' || f.kind === 'radiogroup') && f.label !== null) return true
  // A8 seam (this is the extension plan 1 documented): a hidden file input
  // earns its keep by a resolvable label OR by a file signal (name/id/accept/
  // required). Still no blanket keep — an unlabelled, signal-less hidden file
  // input (the autofill pane) is junk. The raw signals, not the resume score:
  // a cover-letter input the scorer vetoes (#37) is still a row to show.
  // #46: a picker whose only label was its upload button's words ("Attach")
  // now has no label, and is still the row it was while it had one.
  // #54: an anonymous picker (no label, no name, no id) is not kept on its
  // accept alone, see fileSignalKeeps.
  if (f.kind === 'file' && (f.label !== null || f.uploadWordingOnly === true || fileSignalKeeps(f))) return true
  return false
}

/**
 * #54: a hidden, unlabelled file picker's file signals keep it only when it has
 * something to say what it is for: a name, an id or a required mark. Its accept
 * alone says only which files it takes, and every upload on a page takes
 * documents. Ashby's "Autofill from resume" picker has nothing but its accept,
 * while its real Resume upload beside it carries an id and a required mark,
 * so this rule is generic and needs no Ashby module.
 */
function fileSignalKeeps(f: EnumField): boolean {
  const anonymous = f.name === null && f.idAttr === null
  if (anonymous && !f.required) return false
  return fileSignalScore(f) > 0
}

export function dropJunk(fields: EnumField[]): EnumField[] {
  return fields.filter(keepField)
}

/** The Controls a user picks one Option from a list in. */
const DROPDOWN_KINDS: ReadonlySet<EnumField['kind']> = new Set(['select', 'combobox'])

/**
 * #53: the Fields a Scan kept after the junk filter are no form when they are
 * one dropdown that already holds a Value and sits outside any form element,
 * such as a listing page's language dropdown. A Field with no `inForm` mark,
 * from a page script loaded before #53, reads as inside a form. Nothing wider:
 * two Fields, or a wizard step made only of choice questions, are a form.
 */
export function isNotAForm(kept: readonly EnumField[]): boolean {
  if (kept.length !== 1) return false
  const [only] = kept as [EnumField]
  return DROPDOWN_KINDS.has(only.kind) && only.currentValue !== null && only.inForm === false
}
