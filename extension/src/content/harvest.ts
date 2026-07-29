import { setNativeValue } from './fill'
import { elementByFid } from './enumerate'
import { scopeOf } from './dom'

/** How long one combobox may take to mount an attributable listbox after our
 *  click. Past it the harvest degrades to `[]` — it never fails the scan. */
export const HARVEST_LISTBOX_TIMEOUT_MS = 500
const POLL_MS = 50

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const escAttr = (s: string): string => s.replace(/"/g, '\\"')

function isComboboxShaped(el: Element): boolean {
  return el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox'
}

/** The control's OWN scope first (an open shadow root), then the document —
 *  shadow-DOM walking is a standing no-regression constraint, and ids inside a
 *  shadow root are invisible to `document.querySelector`. The document is still
 *  consulted because real widgets portal their listbox to `<body>`. */
function listboxScopes(root: Document, el: Element): (Document | ShadowRoot)[] {
  const scope = scopeOf(el)
  return scope === root ? [root] : [scope as ShadowRoot, root]
}

/**
 * The listbox ATTRIBUTION rule (A6, reused by B2's fillCombobox hardening): a
 * listbox belongs to the control iff the control points at it
 * (aria-owns/aria-controls) or it appeared AFTER our interaction (`before` =
 * the listboxes mounted pre-click). The document-wide "any listbox" fallback is
 * exactly the cross-combobox bug the spec kills — never add it back. Both
 * lookups run over the control's scope AND the document, in that order.
 */
export function attributableListbox(root: Document, el: Element, before: ReadonlySet<Element>): Element | null {
  const scopes = listboxScopes(root, el)
  const owns = el.getAttribute('aria-owns') ?? el.getAttribute('aria-controls')
  if (owns !== null) {
    const first = owns.split(/\s+/)[0]
    if (first !== undefined && first !== '') {
      for (const s of scopes) {
        const found = s.querySelector(`[id="${escAttr(first)}"]`)
        if (found !== null) return found
      }
    }
  }
  for (const s of scopes) {
    for (const lb of Array.from(s.querySelectorAll('[role="listbox"]'))) {
      if (!before.has(lb)) return lb
    }
  }
  return null
}

/** The pre-interaction listbox set, over the SAME scopes attribution searches —
 *  a shadow listbox missing from `before` would be misread as "appeared after
 *  our click". Exported because B2's fillCombobox must build it identically. */
export function mountedListboxes(root: Document, el: Element): Set<Element> {
  const out = new Set<Element>()
  for (const s of listboxScopes(root, el)) {
    for (const lb of Array.from(s.querySelectorAll('[role="listbox"]'))) out.add(lb)
  }
  return out
}

function optionTexts(listbox: Element): string[] {
  return Array.from(listbox.querySelectorAll('[role="option"]'))
    .map((o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((t) => t !== '')
}

async function harvestOne(root: Document, el: Element): Promise<string[]> {
  // Snapshot BEFORE touching anything: a page-sourced value (e.g. the ATS
  // resume auto-parse) must survive the harvest identically.
  const snapshot = el instanceof HTMLInputElement ? el.value : null
  const before = mountedListboxes(root, el)

  ;(el as HTMLElement).click()

  let options: string[] = []
  const deadline = Date.now() + HARVEST_LISTBOX_TIMEOUT_MS
  for (;;) {
    const listbox = attributableListbox(root, el, before)
    if (listbox !== null) {
      options = optionTexts(listbox)
      if (options.length > 0) break
    }
    if (Date.now() >= deadline) break
    await wait(POLL_MS)
  }

  // Close the way a user backs out: Escape, then blur. No typing, ever.
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  if (el instanceof HTMLElement) el.blur()

  // Restore the SNAPSHOT if open/close mutated the value. The restore target is
  // always the snapshot itself — never a clear-to-'' "reset" (spec A6).
  if (el instanceof HTMLInputElement && snapshot !== null && el.value !== snapshot) {
    setNativeValue(el, snapshot)
  }
  return options
}

/** JFF_HARVEST body: per-fid mounted option texts; `[]` on any failure. String
 *  keys because the reply crosses the JSON message boundary. */
export async function harvestOptions(root: Document, fids: number[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const fid of fids) {
    const el = elementByFid(root, fid)
    if (el === null || !isComboboxShaped(el)) {
      out[String(fid)] = []
      continue
    }
    try {
      out[String(fid)] = await harvestOne(root, el)
    } catch {
      // One broken combobox must not kill the batch — degrade to "no options".
      out[String(fid)] = []
    }
  }
  return out
}
