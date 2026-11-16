import { CAPTURE_CUT_MARK, CAPTURE_MAX_CHARS, cleanForPrivacy, norm, type CapturedPage } from '@jff/shared'
import { isSoleControl, kindOf } from './dom'

/**
 * A Capture's page (spec #41). The page script cleans a COPY of its document
 * and hands back only that, so raw HTML never leaves the tab and the page the
 * applicant is filling is not touched.
 *
 * Beside the shared privacy step, it blanks inside each Control's own widget
 * any text equal to the Value that Control holds. A committed dropdown choice
 * is shown by the page as ordinary text beside an emptied search box, which no
 * Control-level cleaning reaches. An Option label is never blanked, there or
 * elsewhere: a blank among a list's Options would point at the chosen one.
 */

const FID_ATTR = 'data-jff-fid'

/** How far above a Control its widget may reach: the same reach the Fill's
 *  commit check reads a committed choice within (fill.ts). */
const WIDGET_DEPTH = 5

/** Text inside these is an Option label, kept wherever it sits. */
const OPTION_TEXT = 'option, optgroup, datalist, [role="option"], [role="listbox"]'

/** Attributes a widget shows or keeps its Value in. Never one that names or
 *  wires an element (`id`, `class`, `type`, `for`), whatever its value. */
const SHOWN_ATTRS = new Set(['value', 'title', 'alt', 'aria-label', 'aria-valuetext', 'aria-description', 'placeholder'])
const shownAttr = (name: string): boolean => SHOWN_ATTRS.has(name) || name.startsWith('data-')

/** A Value the Side panel knows for one Field of this frame. */
export interface HeldValue { fid: number; value: string }

/** The Values a Control shows itself: what was typed, the chosen native
 *  Option, the text a dropdown drawn without an input shows, a chosen file's
 *  name. A box or a radio holds an Option label, which is never blanked. */
function ownValues(el: Element): string[] {
  const kind = kindOf(el)
  if (kind === 'select') {
    return Array.from((el as HTMLSelectElement).selectedOptions)
      .filter((o) => o.value !== '' && !o.disabled)
      .map((o) => o.textContent ?? '')
  }
  if (kind === 'file') return Array.from((el as HTMLInputElement).files ?? []).map((f) => f.name)
  if (kind === 'combobox') {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return [el.value]
    return [el.textContent ?? '']
  }
  if (kind === 'text' || kind === 'textarea') return [(el as HTMLInputElement | HTMLTextAreaElement).value]
  return []
}

/** The Control's own widget: the highest ancestor, within WIDGET_DEPTH, that
 *  holds no other Control, never the form or the body. */
function widgetOf(control: Element): Element {
  let widget = control
  let node = control.parentElement
  for (let depth = 0; node !== null && depth < WIDGET_DEPTH; depth++, node = node.parentElement) {
    if (node.tagName === 'FORM' || node.tagName === 'BODY' || node.tagName === 'HTML') break
    if (!isSoleControl(node, control)) break
    widget = node
  }
  return widget
}

/** Every element of a document in document order, the root first. A deep copy
 *  lists its elements in the same order, so one index names the same element
 *  in both. */
function elementsOf(doc: Document): Element[] {
  return [doc.documentElement, ...Array.from(doc.documentElement.querySelectorAll('*'))]
}

/** Blanks, under `widget`, every text and shown attribute equal to one of
 *  `values`, outside any Option label. */
function blankHeld(doc: Document, widget: Element, values: ReadonlySet<string>): void {
  const walker = doc.createTreeWalker(widget, 0x4 /* SHOW_TEXT */)
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  for (const text of texts) {
    if (text.parentElement?.closest(OPTION_TEXT) != null) continue
    if (values.has(norm(text.data))) text.data = ''
  }
  for (const el of [widget, ...Array.from(widget.querySelectorAll('*'))]) {
    if (el.closest(OPTION_TEXT) !== null) continue
    for (const { name, value } of Array.from(el.attributes)) {
      if (shownAttr(name) && values.has(norm(value))) el.setAttribute(name, '')
    }
  }
}

/** The page, cleaned for a Capture and capped at CAPTURE_MAX_CHARS. `held` is
 *  what the Side panel knows each Field of this frame holds, by fid; the page
 *  itself is left exactly as it was. */
export function capturePage(doc: Document, held: readonly HeldValue[]): CapturedPage {
  const byFid = new Map<string, string[]>()
  for (const { fid, value } of held) byFid.set(String(fid), [...(byFid.get(String(fid)) ?? []), value])

  const live = elementsOf(doc)
  const position = new Map(live.map((el, index) => [el, index]))
  const copy = doc.cloneNode(true) as Document
  const copied = elementsOf(copy)

  // Read on the live page, which holds the typed Values the copy may not;
  // written on the copy, before the privacy step removes anything and the two
  // lists stop lining up.
  for (const el of live) {
    const kind = kindOf(el)
    if (kind === null || kind === 'checkbox' || kind === 'radiogroup') continue
    const fid = el.getAttribute(FID_ATTR)
    const values = new Set(
      [...ownValues(el), ...(fid === null ? [] : byFid.get(fid) ?? [])].map(norm).filter((v) => v !== ''),
    )
    if (values.size === 0) continue
    const target = copied[position.get(widgetOf(el)) ?? -1]
    if (target !== undefined) blankHeld(copy, target, values)
  }

  cleanForPrivacy(copy)
  const html = `<!DOCTYPE html>\n${copy.documentElement.outerHTML}`
  if (html.length <= CAPTURE_MAX_CHARS) return { html, cut: false }
  return { html: html.slice(0, CAPTURE_MAX_CHARS - CAPTURE_CUT_MARK.length) + CAPTURE_CUT_MARK, cut: true }
}
