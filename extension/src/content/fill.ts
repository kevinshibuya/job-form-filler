import { norm, optionSetLabels, type FieldHandle, type FillReport } from '@jff/shared'
import { groupBoxesOf } from './checkboxGroup'
import { optionLabelOf, scopeOf } from './dom'
import { defaultMeasure, detectChoice, elementByFid, selfHidden, type ChoiceDetection } from './enumerate'
import { attributableListbox, mountedListboxes } from './harvest'
import { waitForSettle } from './settle'

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

/**
 * A TYPED input (number, date, email, url, …) silently DISCARDS a value it
 * cannot parse: the assignment does not throw, the page logs "The specified
 * value cannot be parsed, or is out of range" and keeps an EMPTY value.
 * Returning ok on that is how a row gets marked "on the page" while the page
 * took nothing — found live on Greenhouse, where 'Imediato' was written into
 * a numeric date-year input.
 *
 * Empty-after-writing-non-empty is the unambiguous rejection signature. Any
 * other divergence is the page NORMALISING (trimming, a canonical date), which
 * is a success reported through `committed`, exactly as the widget paths do.
 */
function fillTextual(el: HTMLInputElement | HTMLTextAreaElement, value: string): FillOutcome {
  setNativeValue(el, value)
  if (el.value === '' && value !== '') return { ok: false, reason: 'value-rejected' }
  if (el.value === value) return { ok: true }
  return { ok: true, committed: el.value }
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

/**
 * A box holds yes or no and nothing else: any other Value (a link, an email
 * address, a place) is refused with the box untouched, never read as "no".
 * "filled" means the box ENDS in the asked state, so the state is read back a
 * frame after the click, once the page's framework has had its turn to put
 * its own state back.
 */
async function fillCheckbox(el: HTMLInputElement, value: string): Promise<FillOutcome> {
  const v = value.trim()
  const want = AFFIRMATIVE_RE.test(v) ? true : NEGATIVE_RE.test(v) ? false : null
  if (want === null) return { ok: false, reason: 'value-not-yes-no' }
  if (el.checked === want) return { ok: true }
  el.click()
  await nextFrame()
  if (el.checked !== want) return { ok: false, reason: 'click-rejected' }
  return { ok: true }
}

/**
 * A checkbox group's Value is a set of Option labels, one per line. The Fill
 * leaves exactly the chosen Options ticked: every chosen label must name a box
 * (under `norm`) or nothing is touched, then each box whose state differs is
 * clicked, and "filled" is reported only once every box's checked state, read
 * back a frame later, is the one asked for.
 */
async function fillCheckboxGroup(boxes: HTMLInputElement[], value: string): Promise<FillOutcome> {
  const chosen = new Set<HTMLInputElement>()
  for (const label of optionSetLabels(value)) {
    const target = norm(label)
    const hit = boxes.find((b) => norm(optionLabelOf(b)) === target) ?? boxes.find((b) => norm(b.value) === target)
    if (hit === undefined) return { ok: false, reason: 'no-matching-option' }
    chosen.add(hit)
  }
  for (const box of boxes) {
    if (box.checked !== chosen.has(box)) box.click()
  }
  await nextFrame()
  if (boxes.some((box) => box.checked !== chosen.has(box))) return { ok: false, reason: 'click-rejected' }
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
 * desired state. Step 0 below already reports ok with zero clicks when the
 * page verifiably shows the requested state — an AFFIRMATIVE-checked box
 * matching an affirmative fill, a checked matching radio, or an already-active
 * button. A checkbox in the NEGATIVE direction is different: unchecked is
 * indistinguishable from "never answered" on these button-driven widgets, so
 * it still gets no silent ok here — the buttons are the page's real state
 * machine, and "filling No silently no-ops" is the exact lie this function
 * exists to kill (spec B1).
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
/** How long a committed Option's menu may take to close before the commit is
 *  called failed (spec D1). */
export const COMMIT_SETTLE_MS = 500
/** How long a menu another Control left open may take to close after Escape
 *  and blur, before this Fill refuses to open its own (spec D2). */
export const CLOSE_WAIT_MS = 500
/** The ceiling on the settle wait between two consecutive choice Fills (D3). */
export const CHOICE_GAP_SETTLE_MS = 300

/**
 * C2: react-select (Greenhouse) opens its menu ONLY on a real pointer gesture —
 * el.click() alone, a lone synthetic mousedown, ArrowDown and a native-setter
 * input while closed are all no-ops (C1 spike, proven live on the real Degree
 * widget). The full bubbling pointer+mouse sequence is what a trusted user
 * press produces; widgets that open on a plain click (Ashby) see their click
 * at the end of the sequence, so the old behavior is a strict subset.
 * PointerEvent falls back to MouseEvent where the environment lacks it (jsdom)
 * — listeners dispatch by TYPE, so the constructor difference is inert.
 */
function dispatchOpenGesture(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true } as const
  const pointer = (type: string): Event =>
    typeof PointerEvent === 'function'
      ? new PointerEvent(type, { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, opts)
  el.dispatchEvent(pointer('pointerdown'))
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  el.dispatchEvent(pointer('pointerup'))
  el.dispatchEvent(new MouseEvent('mouseup', opts))
  el.dispatchEvent(new MouseEvent('click', opts))
}

/** The candidate leaves the commit fallback may read: every childless element
 *  within ≤5 ancestor levels of the input, excluding the input itself and
 *  anything inside ANY listbox (menu remnants and the page's permanently-
 *  mounted intl-tel-input decoy included). */
function commitScopeLeaves(input: HTMLInputElement): HTMLElement[] {
  // A Set: each ancestor's querySelectorAll re-visits the levels below it, and
  // without dedupe every leaf would be collected (and style-walked) up to 5×.
  const out = new Set<HTMLElement>()
  let scope: Element | null = input.parentElement
  for (let depth = 0; scope !== null && depth < 5; depth++, scope = scope.parentElement) {
    for (const node of Array.from(scope.querySelectorAll<HTMLElement>('*'))) {
      if (node === input || node.closest('[role="listbox"]') !== null) continue
      if (node.children.length === 0) out.add(node)
    }
  }
  return [...out]
}

/** Computed-style walk, NOT offsetParent/rects: jsdom renders no layout (every
 *  rect is zero), and display:none / visibility:hidden — plus the `hidden`
 *  attribute and aria-hidden — are exactly what the decoy and closed-menu
 *  remnants wear in both environments. */
const isDisplayHidden = (node: HTMLElement): boolean => {
  for (let el: HTMLElement | null = node; el !== null; el = el.parentElement) {
    if (el.hidden === true || el.getAttribute('aria-hidden') === 'true') return true
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return true
  }
  return false
}

/**
 * C2: react-select commits by CLEARING its input and rendering the committed
 * text in a sibling value container (.select__single-value on the real page —
 * but the walk is STRUCTURAL, never class-named). Hardened two ways (plan
 * review): the node must be VISIBLE, and its text must have CHANGED INTO the
 * option's across the commit click — pre-existing page text that merely
 * matches ('Other', 'Yes', …) is not evidence the widget committed anything.
 * A node absent from the pre-click snapshot is a fresh value render and counts.
 */
function visibleCommittedText(
  input: HTMLInputElement,
  optionTextNorm: string,
  preTexts: WeakMap<HTMLElement, string>,
): string | null {
  for (const node of commitScopeLeaves(input)) {
    if (isDisplayHidden(node)) continue
    const text = node.textContent ?? ''
    if (norm(text) !== optionTextNorm) continue
    const before = preTexts.get(node)
    if (before !== undefined && norm(before) === optionTextNorm) continue
    return text.trim()
  }
  return null
}

/** A menu is visible while it is mounted and not hidden by attribute or
 *  computed style. A hidden but mounted menu (a closed intl-tel-input flag
 *  list) is never a menu left open. */
const menuVisible = (lb: Element | null): boolean =>
  lb !== null && lb.isConnected && !(lb instanceof HTMLElement && isDisplayHidden(lb))

/** The id tokens a control points at through aria-controls and aria-owns. */
const ownedIds = (el: Element): string[] =>
  [el.getAttribute('aria-controls'), el.getAttribute('aria-owns')]
    .flatMap((v) => (v ?? '').split(/\s+/))
    .filter((t) => t !== '')

/** The element that owns a listbox by aria-controls or aria-owns, if any. */
function ownerOf(lb: Element): Element | null {
  if (lb.id === '') return null
  const id = lb.id.replace(/"/g, '\\"')
  const scope = lb.getRootNode() as Document | ShadowRoot
  return scope.querySelector(`[aria-controls~="${id}"], [aria-owns~="${id}"]`)
}

/**
 * D2: before a Fill opens its control, a menu another Control left visible is
 * closed — Escape to the element that owns it (else the active element), then
 * a blur — and the Fill waits up to CLOSE_WAIT_MS for it to go. The control's
 * OWN menu is not a foreign one: a widget whose list stays mounted is opened
 * as before. Returns false when a foreign menu is still visible.
 */
async function closeForeignMenus(el: Element): Promise<boolean> {
  const own = new Set(ownedIds(el))
  const foreign = [...mountedListboxes(document, el)].filter((lb) => menuVisible(lb) && !own.has(lb.id))
  if (foreign.length === 0) return true
  for (const lb of foreign) {
    const owner = ownerOf(lb) ?? document.activeElement
    if (owner === null) continue
    owner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    if (owner instanceof HTMLElement) owner.blur()
  }
  const deadline = Date.now() + CLOSE_WAIT_MS
  for (;;) {
    if (!foreign.some(menuVisible)) return true
    if (Date.now() >= deadline) return false
    await wait(COMBOBOX_POLL_MS)
  }
}

/** The control that reports the menu's state: the element itself, or the
 *  closest `[role=combobox]` around it. */
const expandedOwner = (el: Element): Element =>
  el.getAttribute('role') === 'combobox' ? el : (el.closest('[role="combobox"]') ?? el)

/**
 * B1: interact ONLY with a listbox attributable to this control — aria-owns/
 * aria-controls, or one that appeared in response to OUR interaction (the same
 * attributableListbox rule the harvest defined; the document-wide fallback was
 * the cross-combobox bug). The open gesture stays (C2 widened the bare click
 * into the full pointer+mouse sequence), then the typeahead is ALWAYS
 * driven when there is an input to type into: real Ashby comboboxes ("Start
 * typing...") mount options only AFTER keystrokes, so bailing on "no listbox
 * yet" was the silent no-op the user filmed (spec D1).
 *
 * Matching ladder: exact normalized match, else a UNIQUE normalized-substring
 * match — zero or ambiguous fails closed (never guess between candidates).
 * The substring tier is gated further (review fix): it is only even
 * considered when the typed value is at least 3 characters (a 2-letter value
 * like 'UK' can be a contiguous substring of some unrelated option — 'uk' is
 * a prefix of 'ukraine' — while the option the user actually meant, 'United
 * Kingdom', never contains it contiguously at all), and a unique substring
 * hit is only ACCEPTED once the attributable listbox's option-text set is
 * identical across two consecutive polls — a transiently single-option list
 * (more options still mounting) must never be mistaken for a settled,
 * unambiguous one. Exact matches stay eager: first poll wins, no settling
 * wait.
 * D1: the Option is committed with the same pointer sequence that opens the
 * menu, and the commit is verified in two steps: the menu CLOSED within
 * COMMIT_SETTLE_MS, then EVIDENCE that the page kept the Option. A typed text
 * that merely equals the Option is never evidence by itself: it has to survive
 * a blur, because a discarded typeahead is cleared on blur and a commit is
 * not. Either step failing is `no-commit`. Success means the page committed
 * the CLICKED OPTION's text; the requested value no longer has to equal it
 * ('bra' legitimately commits 'Brazil'), and `committed` reports the
 * canonical text when it differs. Every failure path
 * restores the pre-fill snapshot (never a clear to ''), waits a frame, THEN
 * closes via Escape+blur — the restore write is itself an input event, and
 * fired after Escape it would re-open the dropdown just closed. A type-to-load
 * page may still refetch options on that restore event; the residual is
 * page-side and is eyeballed at the manual gate (review fix, majors item 5).
 */
async function fillCombobox(el: Element, value: string): Promise<FillOutcome> {
  const input = el instanceof HTMLInputElement ? el : null
  const snapshot = input === null ? null : input.value
  // D2: never open a second menu while another Control's is still up.
  if (!await closeForeignMenus(el)) return { ok: false, reason: 'listbox-left-open' }
  const before = mountedListboxes(document, el)
  // C2: the full pointer+mouse open gesture, dispatched on the control itself
  // (bubbling from the input reaches the react-select control wrapper).
  if (el instanceof HTMLElement) dispatchOpenGesture(el)
  const target = norm(value)

  const lookup = (): { mounted: boolean; options: HTMLElement[] } => {
    const listbox = attributableListbox(document, el, before)
    if (listbox === null) return { mounted: false, options: [] }
    return { mounted: true, options: Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')) }
  }

  // Substring tier: a stability snapshot of the listbox's full option-text set
  // from the PREVIOUS poll. A unique substring hit is only trusted once this
  // matches the CURRENT poll's set too — two consecutive identical reads.
  // Shared across both waitForHit calls below (open-click, then typeahead);
  // each poll cycle either confirms stability or resets it.
  let prevOptionsKey: string | null = null
  const optionsKey = (options: HTMLElement[]): string =>
    options.map((o) => norm(o.textContent ?? '')).join(' ')
  const MIN_SUBSTRING_LEN = 3

  let sawListbox = false
  const waitForHit = async (waitMs: number, breakOnOptions: boolean): Promise<HTMLElement | null> => {
    const deadline = Date.now() + waitMs
    for (;;) {
      const m = lookup()
      sawListbox = sawListbox || m.mounted
      const exact = m.options.find((o) => norm(o.textContent ?? '') === target)
      if (exact !== undefined) return exact

      // B1b ladder. Ambiguity (or a too-short target) fails closed: clicking
      // one of several substring candidates would be a guess, and a wrong
      // option is worse than asking. A unique candidate is only RETURNED once
      // it survives two consecutive polls unchanged — `settled` below.
      let uniquePartial: HTMLElement | null = null
      if (target.length >= MIN_SUBSTRING_LEN) {
        const partial = m.options.filter((o) => norm(o.textContent ?? '').includes(target))
        uniquePartial = partial.length === 1 ? partial[0]! : null
      }
      const key = optionsKey(m.options)
      const settled = key === prevOptionsKey
      prevOptionsKey = key
      if (uniquePartial !== null && settled) return uniquePartial

      // Options are mounted and there is no candidate even awaiting its settle
      // confirmation: waiting longer adds nothing — the typeahead is the next
      // move. A PENDING unique candidate (not yet settled) is worth one more
      // poll even on this fast path, so it is exempted from the early break.
      if (breakOnOptions && m.options.length > 0 && uniquePartial === null) return null
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
  const hitListbox = hit.closest('[role="listbox"]')
  // C2 hardening: snapshot the candidate leaves' texts BEFORE the commit
  // click, so the fallback can demand a CHANGE into the option text.
  const preTexts = new WeakMap<HTMLElement, string>()
  if (input !== null) {
    for (const node of commitScopeLeaves(input)) preTexts.set(node, node.textContent ?? '')
  }
  // What the input held right before the commit: the typed text on the
  // typeahead path, the pre-fill value when the open gesture found the Option.
  const preCommit = input === null ? null : input.value
  // D1: the commit gesture is the open gesture (a strict superset of a click),
  // for the reason C2 widened the open: react-select ignores a bare click.
  dispatchOpenGesture(hit)
  await nextFrame()

  // Step 1, CLOSED: the listbox the Option came from and any listbox now
  // attributable to the control are gone or hidden, or the control reports
  // aria-expanded="false". Re-querying attribution catches a widget that
  // re-rendered a fresh, still-open menu in place of the old one.
  const closed = (): boolean =>
    expandedOwner(el).getAttribute('aria-expanded') === 'false'
    || (!menuVisible(hitListbox) && !menuVisible(attributableListbox(document, el, before)))
  const closeBy = Date.now() + COMMIT_SETTLE_MS
  while (!closed()) {
    if (Date.now() >= closeBy) return failClosed('no-commit')
    await wait(COMBOBOX_POLL_MS)
  }

  // Step 2, EVIDENCE. B1c: EXACT normalized equality against the CLICKED
  // OPTION's text, never `includes`: a widget that committed 'United States
  // Minor Outlying Islands' after a 'United States' click would still
  // false-pass an includes check.
  if (input === null) {
    // Non-input widgets report their textContent TRIMMED (review fix, minors 17).
    const shown = (el.textContent ?? '').trim()
    if (norm(shown) !== optionText) return failClosed('no-commit')
    return { ok: true, committed: shown === value ? null : shown }
  }
  let committed: string | null = null
  if (input.value === '') {
    // (a) C2 (Greenhouse): react-select CLEARS its input and renders the
    // Option in a visible value container.
    committed = visibleCommittedText(input, optionText, preTexts)
  } else if (norm(input.value) === optionText && input.value !== preCommit) {
    // (b) The widget rewrote the input into the Option's text.
    committed = input.value
  } else if (norm(input.value) === optionText) {
    // (c) The input already held the Option's text. Only a blur tells a commit
    // (kept) from a discarded typeahead (cleared).
    if (document.activeElement !== input) input.focus()
    input.blur()
    await nextFrame()
    if (norm(input.value) === optionText) committed = input.value
  }
  if (committed === null) return failClosed('no-commit')
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
  // A checkbox group, stamped by the enumerator on every one of its boxes.
  const group = groupBoxesOf(el)
  if (group !== null) return fillCheckboxGroup(group, value)
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
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return fillTextual(el, value)
  return { ok: false, reason: 'unsupported-widget' }
}

/** A Control a choice Fill drives: a dropdown, a native select, a radio or a
 *  checkbox (choice widgets and checkbox groups ride on the latter two). */
function isChoiceControl(el: Element): boolean {
  return el.getAttribute('role') === 'combobox'
    || el.getAttribute('aria-haspopup') === 'listbox'
    || el instanceof HTMLSelectElement
    || (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox'))
}

/**
 * Fills run strictly one after another (D3). Between two consecutive choice
 * Fills the page gets a settle wait — quiet for 100 ms, at most
 * CHOICE_GAP_SETTLE_MS — so a menu still animating shut is not overlapped.
 */
export async function fillFields(
  root: Document,
  fills: { handle: FieldHandle; value: string }[],
): Promise<Omit<FillReport, 'epoch'>> {
  const filled: { handle: FieldHandle; committed: string | null }[] = []
  const failed: { handle: FieldHandle; reason: string }[] = []
  let previousWasChoice = false
  for (const f of fills) {
    const el = elementByFid(root, f.handle.fid)
    if (el === null) {
      failed.push({ handle: f.handle, reason: 'element-not-found' })
      previousWasChoice = false
      continue
    }
    const choice = isChoiceControl(el)
    if (choice && previousWasChoice) await waitForSettle(root, { quietMs: 100, maxMs: CHOICE_GAP_SETTLE_MS })
    previousWasChoice = choice
    const out = await fillOne(el, f.value)
    if (out.ok) filled.push({ handle: f.handle, committed: out.committed ?? null })
    else failed.push({ handle: f.handle, reason: out.reason })
  }
  return { filled, failed }
}
