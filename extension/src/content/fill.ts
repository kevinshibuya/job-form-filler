import { norm, type FieldHandle, type FillReport } from '@jff/shared'
import { optionLabelOf, scopeOf } from './dom'
import { defaultMeasure, detectChoice, elementByFid, selfHidden, type ChoiceDetection } from './enumerate'
import { attributableListbox, mountedListboxes } from './harvest'

type FillOutcome = { ok: true; committed?: string | null } | { ok: false; reason: string }

/**
 * React installs its own `value` setter on the element INSTANCE, so `el.value = x`
 * updates React's shadow copy and its onChange never fires. Writing through the
 * PROTOTYPE setter bypasses that; the bubbling input+change events then look like
 * a real user edit to every framework we care about.
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter !== undefined) setter.call(el, value)
  else (el as { value: string }).value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function fillSelect(el: HTMLSelectElement, value: string): FillOutcome {
  const target = norm(value)
  const byLabel = Array.from(el.options).find((o) => norm(o.textContent ?? '') === target)
  const byValue = Array.from(el.options).find((o) => norm(o.value) === target)
  const opt = byLabel ?? byValue
  if (opt === undefined) return { ok: false, reason: 'no-matching-option' }
  setNativeValue(el, opt.value)
  return { ok: true }
}

function fillRadioGroup(el: HTMLInputElement, value: string): FillOutcome {
  const scope = scopeOf(el)
  const name = el.getAttribute('name')
  const members = name === null || name === ''
    ? [el]
    : Array.from(scope.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name.replace(/"/g, '\\"')}"]`))
  const target = norm(value)
  const hit = members.find((m) => norm(optionLabelOf(m)) === target) ?? members.find((m) => norm(m.value) === target)
  if (hit === undefined) return { ok: false, reason: 'no-matching-option' }
  // A React-controlled radio needs a REAL click; assigning .checked does nothing.
  hit.click()
  if (!hit.checked) return { ok: false, reason: 'click-rejected' }
  return { ok: true }
}

function fillCheckbox(el: HTMLInputElement, value: string): FillOutcome {
  const want = /^(true|yes|sim|on|1|checked)$/i.test(value.trim())
  if (el.checked === want) return { ok: true }
  el.click()
  if (el.checked !== want) return { ok: false, reason: 'click-rejected' }
  return { ok: true }
}

/* --------------------------------------------------------------- B1: choice */

/** Submit vocabulary: a button whose normalized text starts with one of these
 *  is NEVER clicked, whatever the other gates say. */
const SUBMIT_WORD_RE = /^(submit|apply|send|continue|next|enviar|candidatar)/i

/** data-state values that mean "this option is currently selected" (Radix and
 *  friends stamp these). Anything else ('unchecked', 'closed', …) is not
 *  evidence of an answered widget. */
const ACTIVE_DATA_STATE: ReadonlySet<string> = new Set(['checked', 'active', 'on', 'true'])

const AFFIRMATIVE_RE = /^(true|yes|sim|on|1|checked)$/i
const NEGATIVE_RE = /^(false|no|não|nao|off|0)$/i

/** The page's framework needs a frame to react before the re-snapshot. rAF in
 *  a real browser; a macrotask where the environment has none (jsdom). */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })

/** Same-name radios in the wrapper are ONE choice control (plan 1's radio
 *  exemption); a checkbox stands alone. */
function choiceMembers(el: HTMLInputElement, wrapper: Element): HTMLInputElement[] {
  if (el.type !== 'radio') return [el]
  const name = el.getAttribute('name')
  if (name === null || name === '') return [el]
  return Array.from(wrapper.querySelectorAll<HTMLInputElement>(
    `input[type="radio"][name="${name.replace(/"/g, '\\"')}"]`,
  ))
}

/** The observable-state fingerprint the spec verifies against: every member's
 *  checked/value plus every button's className and aria/data state. Any delta
 *  between two fingerprints is evidence the page took the fill. */
function choiceFingerprint(members: HTMLInputElement[], buttons: HTMLButtonElement[]): string {
  const inputs = members.map((m) => `${String(m.checked)}|${m.value}`)
  const btns = buttons.map((b) => [
    b.className,
    b.getAttribute('aria-pressed'),
    b.getAttribute('aria-checked'),
    b.getAttribute('data-state'),
  ].join('|'))
  return [...inputs, ...btns].join('\n')
}

/**
 * B1: fill a hidden-input-plus-buttons choice widget, cheapest and safest step
 * first, success ONLY on an observable state change.
 *
 * Step 1 — the hidden input itself, but only when a click can NAME the
 * requested option: the value-matching member radio, or the checkbox when the
 * value maps through the yes/no vocabulary AND the click moves TOWARD the
 * desired state. A checkbox already at the desired state gets no click and no
 * silent ok — the buttons are the page's real state machine, and "filling No
 * silently no-ops" is the exact lie this function exists to kill (spec B1).
 *
 * Step 2 — the gated button click: text match, never submit-worded, and
 * type="button" or no <form> ancestor. The motivating Ashby page has NO <form>
 * at all, so gates (a)/(b) carry the rail there.
 *
 * Last resort — index alignment (member radio at the matching option's index),
 * tried ONLY when step 2's gate refused. It assumes the page renders buttons
 * and radios as parallel arrays; that assumption is cheap to be wrong about
 * only when the alternative is refusing the fill outright.
 */
export async function fillChoice(
  el: HTMLInputElement,
  detection: ChoiceDetection,
  value: string,
): Promise<FillOutcome> {
  const { wrapper, buttons, options } = detection
  const members = choiceMembers(el, wrapper)
  const target = norm(value)

  const clickAndVerify = async (input: HTMLElement): Promise<boolean> => {
    const before = choiceFingerprint(members, buttons)
    input.click()
    await nextFrame()
    return choiceFingerprint(members, buttons) !== before
  }

  // STEP 0 — the page ALREADY verifiably shows the requested state: report ok
  // without touching anything (spec B5e / D4). This kills the re-scan demotion
  // of correct answers (the session-6 OPEN FINDING) while staying inside
  // "success ONLY on verified page state" — the state IS verified, it just
  // needed no click. Deliberately narrow:
  //  - radio: the CHECKED member names the requested option;
  //  - checkbox: AFFIRMATIVE direction only. An unchecked box is
  //    indistinguishable from "never answered" on the button-driven widgets
  //    this function exists for, so a requested "No" must still click below;
  //  - buttons: the value-matching button already wears an active state.
  if (el.type === 'radio') {
    const active = members.find((m) => m.checked)
    if (active !== undefined && (norm(active.value) === target || norm(optionLabelOf(active)) === target)) {
      return { ok: true }
    }
  } else if (AFFIRMATIVE_RE.test(target) && el.checked) {
    return { ok: true }
  }
  const wornBtn = buttons.find((b) => norm(b.textContent ?? '') === target)
  if (wornBtn !== undefined && (
    wornBtn.getAttribute('aria-pressed') === 'true'
    || wornBtn.getAttribute('aria-checked') === 'true'
    || ACTIVE_DATA_STATE.has(wornBtn.getAttribute('data-state') ?? '')
  )) return { ok: true }

  // STEP 1 — only an input that NAMES the option: the member whose value attr
  // or option label matches. Index alignment is deliberately NOT a step-1
  // candidate: "buttons and radios are parallel arrays" is an assumption about
  // the page, and when it is wrong the click answers the WRONG option — a
  // misfill, which is worse than asking the user. It comes back below as a last
  // resort, once the safer button path has refused.
  const optIndex = options.findIndex((o) => norm(o) === target)
  const byIndex = el.type === 'radio' && members.length === options.length && optIndex >= 0
    ? members[optIndex] ?? null
    : null

  let stepOneTarget: HTMLInputElement | null = null
  if (el.type === 'radio') {
    const byValue = members.find((m) => norm(m.value) === target)
    const byLabel = members.find((m) => norm(optionLabelOf(m)) === target)
    stepOneTarget = byValue ?? byLabel ?? null
  } else if (AFFIRMATIVE_RE.test(target) || NEGATIVE_RE.test(target)) {
    const want = AFFIRMATIVE_RE.test(target)
    if (el.checked !== want) stepOneTarget = el
  }
  if (stepOneTarget !== null && await clickAndVerify(stepOneTarget)) return { ok: true }

  // STEP 2 — the gated button click.
  const btn = buttons.find((b) => norm(b.textContent ?? '') === target)
  const gated = btn === undefined
    || !wrapper.contains(btn) // (a) — structural by construction, asserted anyway
    || SUBMIT_WORD_RE.test(norm(btn.textContent ?? '')) // (b)
    || (btn.type !== 'button' && btn.closest('form') !== null) // (c)
  if (gated) {
    // The gate REFUSED (or no button matched). Only now is index alignment
    // worth its risk — the alternative left is handing the row back to the user.
    if (byIndex !== null && byIndex !== stepOneTarget && await clickAndVerify(byIndex)) return { ok: true }
    return { ok: false, reason: 'choice-needs-user-click' }
  }
  if (await clickAndVerify(btn)) return { ok: true }
  return { ok: false, reason: 'no-state-change' }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** How long the combobox may take to mount options after our OPEN click (the
 *  fast path for widgets that mount on click, mirrors HARVEST_LISTBOX_TIMEOUT_MS). */
const COMBOBOX_WAIT_MS = 500
/** …and after our typeahead keystrokes. Real Ashby options come from a
 *  debounced network fetch; 500ms was never enough (spec D1). */
const COMBOBOX_TYPE_WAIT_MS = 2000
const COMBOBOX_POLL_MS = 50

/**
 * B1: interact ONLY with a listbox attributable to this control — aria-owns/
 * aria-controls, or one that appeared in response to OUR interaction (the same
 * attributableListbox rule the harvest defined; the document-wide fallback was
 * the cross-combobox bug). The open click stays, then the typeahead is ALWAYS
 * driven when there is an input to type into: real Ashby comboboxes ("Start
 * typing...") mount options only AFTER keystrokes, so bailing on "no listbox
 * yet" was the silent no-op the user filmed (spec D1).
 *
 * Matching ladder: exact normalized match, else a UNIQUE normalized-substring
 * match — zero or ambiguous fails closed (never guess between candidates).
 * Success iff the page committed the CLICKED OPTION's text; the requested
 * value no longer has to equal it ('bra' legitimately commits 'Brazil'), and
 * `committed` reports the canonical text when it differs. Every failure path
 * restores the pre-fill snapshot (never a clear to ''), waits a frame, THEN
 * closes via Escape+blur — the restore write is itself an input event, and
 * fired after Escape it would re-open the dropdown just closed. A type-to-load
 * page may still refetch options on that restore event; the residual is
 * page-side and is eyeballed at the manual gate (review fix, majors item 5).
 */
async function fillCombobox(el: Element, value: string): Promise<FillOutcome> {
  const input = el instanceof HTMLInputElement ? el : null
  const snapshot = input === null ? null : input.value
  const before = mountedListboxes(document, el)
  ;(el as HTMLElement).click()
  const target = norm(value)

  const lookup = (): { mounted: boolean; options: HTMLElement[] } => {
    const listbox = attributableListbox(document, el, before)
    if (listbox === null) return { mounted: false, options: [] }
    return { mounted: true, options: Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')) }
  }

  // B1b ladder. Ambiguity fails closed: clicking one of several substring
  // candidates would be a guess, and a wrong option is worse than asking.
  const pick = (options: HTMLElement[]): HTMLElement | null => {
    const exact = options.find((o) => norm(o.textContent ?? '') === target)
    if (exact !== undefined) return exact
    const partial = options.filter((o) => norm(o.textContent ?? '').includes(target))
    return partial.length === 1 ? partial[0]! : null
  }

  let sawListbox = false
  const waitForHit = async (waitMs: number, breakOnOptions: boolean): Promise<HTMLElement | null> => {
    const deadline = Date.now() + waitMs
    for (;;) {
      const m = lookup()
      sawListbox = sawListbox || m.mounted
      const hit = pick(m.options)
      if (hit !== null) return hit
      // Options are mounted and nothing (unambiguously) matches: waiting longer
      // adds nothing — the typeahead is the next move.
      if (breakOnOptions && m.options.length > 0) return null
      if (Date.now() >= deadline) return null
      await wait(COMBOBOX_POLL_MS)
    }
  }

  const failClosed = async (reason: string): Promise<FillOutcome> => {
    // Restore FIRST: B1a always types, so the restore write is itself an input
    // event — fired after Escape it would re-open the dropdown we just closed.
    // Order: restore ('' only ever written when '' WAS the snapshot) → one
    // frame for the page to react → Escape + blur (harvest's close recipe).
    if (input !== null && snapshot !== null && input.value !== snapshot) setNativeValue(input, snapshot)
    await nextFrame()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    if (el instanceof HTMLElement) el.blur()
    return { ok: false, reason }
  }
  // B1d: "never opened/attributed" is a different user problem than "your value
  // is not in the list" — the hint copy diverges (Plan-3 Decision 6 debt).
  const noHitReason = (): string => (sawListbox ? 'no-matching-option' : 'combobox-no-listbox')

  let hit = await waitForHit(COMBOBOX_WAIT_MS, true)
  if (hit === null) {
    if (input === null) return failClosed(noHitReason())
    // B1a: ALWAYS drive the typeahead when typing is possible.
    input.focus()
    setNativeValue(input, value)
    hit = await waitForHit(COMBOBOX_TYPE_WAIT_MS, false)
    if (hit === null) return failClosed(noHitReason())
  }

  const optionText = norm(hit.textContent ?? '')
  hit.click()
  await nextFrame()
  // B1c: EXACT normalized equality against the CLICKED OPTION's text, never
  // `includes`: a widget that committed 'United States Minor Outlying Islands'
  // after a 'United States' click would still false-pass an includes check —
  // the misfill-reported-as-success class stays dead.
  // Non-input widgets report their textContent TRIMMED (review fix, minors 17)
  // — the normalized-equality verdict is unaffected either way.
  const committed = input !== null ? input.value : (el.textContent ?? '').trim()
  if (norm(committed) !== optionText) return failClosed('no-matching-option')
  return { ok: true, committed: committed === value ? null : committed }
}

/** DataTransfer is the only way to populate a file input programmatically. */
export function fillFile(el: Element, file: File): FillOutcome {
  if (!(el instanceof HTMLInputElement) || el.type !== 'file') return { ok: false, reason: 'not-a-file-input' }
  const dt = new DataTransfer()
  dt.items.add(file)
  el.files = dt.files
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
}

export async function fillOne(el: Element, value: string): Promise<FillOutcome> {
  // Hard rail: this extension NEVER activates a submit control.
  if (el.tagName === 'BUTTON' || (el instanceof HTMLInputElement && ['submit', 'button', 'reset', 'image'].includes(el.type))) {
    return { ok: false, reason: 'unsupported-widget' }
  }
  if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return fillCombobox(el, value)
  // B1: choice widgets dispatch on LIVE structure — the same detectChoice the
  // enumerator used, under the same selfHidden gate, so filler and enumerator
  // can never disagree — and BEFORE the radio and checkbox branches: radio
  // dispatches first below, and a later placement would swallow radio-backed
  // choices into fillRadioGroup.
  if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox') && selfHidden(defaultMeasure(el))) {
    const choice = detectChoice(el)
    if (choice !== null) return fillChoice(el, choice, value)
  }
  if (el instanceof HTMLSelectElement) return fillSelect(el, value)
  if (el instanceof HTMLInputElement && el.type === 'radio') return fillRadioGroup(el, value)
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return fillCheckbox(el, value)
  if (el instanceof HTMLInputElement && el.type === 'file') return { ok: false, reason: 'file-needs-blob' }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { setNativeValue(el, value); return { ok: true } }
  return { ok: false, reason: 'unsupported-widget' }
}

export async function fillFields(
  root: Document,
  fills: { handle: FieldHandle; value: string }[],
): Promise<Omit<FillReport, 'epoch'>> {
  const filled: { handle: FieldHandle; committed: string | null }[] = []
  const failed: { handle: FieldHandle; reason: string }[] = []
  for (const f of fills) {
    const el = elementByFid(root, f.handle.fid)
    if (el === null) { failed.push({ handle: f.handle, reason: 'element-not-found' }); continue }
    const out = await fillOne(el, f.value)
    if (out.ok) filled.push({ handle: f.handle, committed: out.committed ?? null })
    else failed.push({ handle: f.handle, reason: out.reason })
  }
  return { filled, failed }
}
