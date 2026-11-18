/**
 * Generic label rules of spec #41 (#46), for every ATS and every plain career
 * page. A leaf of the content-layer import graph: dom.ts and checkboxGroup.ts
 * read labels through it, and it imports nothing of theirs.
 */

/** Elements whose text is a Control's, never a label's: a dropdown's Options,
 *  a button's words, a text area's content, an ARIA list box and its Options. */
const CONTROL_TEXT = 'select, option, optgroup, datalist, textarea, button, [role="listbox"], [role="option"]'

/** Whether the page hides `el` itself: the `hidden` attribute or an inline
 *  `display: none`, as Lever hides the list that repeats a dropdown's Options
 *  with a description each, inside the dropdown's own label. */
function hiddenByPage(el: Element): boolean {
  return el.hasAttribute('hidden') || (el as HTMLElement).style?.display === 'none'
}

/**
 * A label's text with the text of the Controls inside it left out, and the
 * text the page hides inside it, whitespace folded. Lever wraps a dropdown in
 * its own label, so reading the label's whole text joins the question to every
 * Option. The page is not touched: the text is read from a copy.
 */
export function labelText(node: Element): string {
  const skipped = (el: Element): boolean => el.matches(CONTROL_TEXT) || hiddenByPage(el)
  let raw: string
  if (!Array.from(node.querySelectorAll('*')).some(skipped)) {
    raw = node.textContent ?? ''
  } else {
    const copy = node.cloneNode(true) as Element
    for (const el of Array.from(copy.querySelectorAll('*')).filter(skipped)) el.remove()
    raw = copy.textContent ?? ''
  }
  return raw.replace(/\s+/g, ' ').trim()
}

/** The words an upload button shows, seen on real pages (spec #41's review).
 *  The list grows only from a fixture. */
const UPLOAD_WORDINGS: ReadonlySet<string> = new Set(['attach', 'upload a file', 'replace file', 'uploading'])

/**
 * Whether `text` is an upload button's words, which are never a file picker's
 * label: compared without regard to case or trailing dots ("Uploading...",
 * "Upload a file.").
 */
export function isUploadWording(text: string | null | undefined): boolean {
  const key = (text ?? '').replace(/\s+/g, ' ').trim().replace(/[.…]+$/, '').trim().toLowerCase()
  return UPLOAD_WORDINGS.has(key)
}
