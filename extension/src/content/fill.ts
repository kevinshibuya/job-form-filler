import { OPTIONS_READ, norm, optionSetLabels, phoneParts, type CityParts, type FieldHandle, type FillReport, type PhoneParts } from '@jff/shared'
import { groupBoxesOf } from './checkboxGroup'
import { pickCityOption } from './cityTypeahead'
import { isSoleControl, optionLabelOf, scopeOf } from './dom'
import { defaultMeasure, detectChoice, elementByFid, selfHidden, type ChoiceDetection } from './enumerate'
import { attributableListbox, mountedListboxes } from './listbox'
import { matchOption, type OptionMatch } from './optionMatch'
import { namesPhoneCountry, phoneSelectorsOf, pickCountryOption } from './phoneSelector'
import { waitForSettle } from './settle'

/**
 * `options`: the Options a Fill of a choice Control read on the page, on a hit
 * and on a miss, so the Side panel can offer them as a picker (ADR 0009: a
 * Scan opens no menu, so a dropdown's Options are first known here).
 */
type FillOutcome =
  | { ok: true; committed?: string | null; options?: string[] }
  | { ok: false; reason: string; options?: string[] }

/** The outcome with the Options read on the page attached; none when the page showed none. */
const withOptions = (out: FillOutcome, options: readonly string[]): FillOutcome =>
  options.length === 0 ? out : { ...out, options: [...options] }

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

/** An Option's wording as the page shows it, spacing collapsed. */
const wording = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** What a filled choice reports: the page's wording of the chosen Option when it
 *  differs from the Value sent ('Germany' fills 'Alemanha'), else nothing. */
const committedAs = (shown: string, value: string): FillOutcome =>
  shown === value ? { ok: true } : { ok: true, committed: shown }

/**
 * The one member whose Option label equals the Value or a candidate word, else
 * the one whose `value` attribute does. Two equal labels, or none and two
 * equal attributes, pick nothing: Fill never guesses between Options.
 */
function pickMember<T>(
  members: readonly T[], labelOf: (m: T) => string, attrOf: (m: T) => string,
  value: string, candidates: readonly string[],
): T | null {
  const byLabel = matchOption(members.map(labelOf), value, candidates)
  if (byLabel.found === 'one') return members[byLabel.index]!
  if (byLabel.found === 'many') return null
  const byAttr = matchOption(members.map(attrOf), value, candidates)
  return byAttr.found === 'one' ? members[byAttr.index]! : null
}

/** The Options of a list as the page words them, blanks dropped: the same
 *  texts Enumeration reports for a native select. */
const wordings = (texts: readonly string[]): string[] => texts.map(wording).filter((t) => t !== '')

function fillSelect(el: HTMLSelectElement, value: string, candidates: readonly string[]): FillOutcome {
  const options = wordings(Array.from(el.options, (o) => o.textContent ?? ''))
  const opt = pickMember(Array.from(el.options), (o) => o.textContent ?? '', (o) => o.value, value, candidates)
  if (opt === null) return withOptions({ ok: false, reason: 'no-matching-option' }, options)
  setNativeValue(el, opt.value)
  return withOptions(committedAs(wording(opt.textContent ?? ''), value), options)
}

/** The radios of the group a radio belongs to: same name, same scope. */
function radioMembersOf(el: HTMLInputElement): HTMLInputElement[] {
  const name = el.getAttribute('name')
  return name === null || name === ''
    ? [el]
    : Array.from(scopeOf(el).querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name.replace(/"/g, '\\"')}"]`))
}

function fillRadioGroup(el: HTMLInputElement, value: string, candidates: readonly string[]): FillOutcome {
  const members = radioMembersOf(el)
  const options = wordings(members.map(optionLabelOf))
  const hit = pickMember(members, optionLabelOf, (m) => m.value, value, candidates)
  if (hit === null) return withOptions({ ok: false, reason: 'no-matching-option' }, options)
  // A React-controlled radio needs a REAL click; assigning .checked does nothing.
  hit.click()
  if (!hit.checked) return withOptions({ ok: false, reason: 'click-rejected' }, options)
  return withOptions(committedAs(wording(optionLabelOf(hit)), value), options)
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
  candidates: readonly string[] = [],
): Promise<FillOutcome> {
  // With candidate words the Value is first turned into the page's wording of
  // the one Option it names; the steps below then fill that Option.
  if (candidates.length > 0) {
    const m = matchOption(detection.options, value, candidates)
    if (m.found !== 'one') return { ok: false, reason: 'no-matching-option' }
    const shown = detection.options[m.index]!
    const out = await fillChoice(el, detection, shown)
    return out.ok ? committedAs(wording(shown), value) : out
  }
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
 *  fast path for widgets that mount on click). */
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
 * A Value that is a paragraph of prose (a line break, or longer than any
 * Option's wording runs) is never typed into a dropdown: a Saved answer
 * written for a free-text question matches no Option, and typing it would
 * only feed the page's search a sentence.
 */
const PROSE_MIN_LENGTH = 100
const isProse = (value: string): boolean => /\n/.test(value.trim()) || value.trim().length >= PROSE_MIN_LENGTH

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
 * A blur the page hears. With the Side panel focused, the page has no focus
 * and Blink sends it no focus events, so `blur()` alone is never heard: the
 * blur and focusout are then dispatched as the user's leaving would send them.
 */
function blurHeard(el: Element): void {
  if (!(el instanceof HTMLElement)) return
  const heard = el.ownerDocument.hasFocus() && el.ownerDocument.activeElement === el
  el.blur()
  if (heard) return
  el.dispatchEvent(new FocusEvent('blur'))
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

/** Backs out of a menu the way a user does: an Escape press (keydown and keyup), then leaving the control. */
function backOut(el: Element): void {
  const key = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }
  el.dispatchEvent(new KeyboardEvent('keydown', key))
  el.dispatchEvent(new KeyboardEvent('keyup', key))
  blurHeard(el)
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
    backOut(owner)
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
 * attributableListbox rule in listbox.ts; the document-wide fallback was
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
/** How a Fill other than a plain dropdown's drives `fillCombobox`. */
interface ComboboxHow {
  /**
   * Chooses the Option itself in place of the equality and substring tiers: a
   * phone's country selector words its Options "United States +1", and a city
   * typeahead's results name the city with its region and country.
   */
  pick?: (options: readonly string[]) => OptionMatch
  /**
   * The phone Fill's: true when the control shows the phone's country. The
   * Fill calls it only on a control that did not show it before the commit, so
   * a true after the commit is a change, and evidence the page kept the pick.
   */
  shows?: () => boolean
  /**
   * The city Fill's: the results of a search arrive one by one, so a pick is
   * taken only once they stay the same across two polls, and a miss reports
   * the results the search returned as the Options.
   */
  search?: boolean
}

async function fillCombobox(
  el: Element, value: string, candidates: readonly string[], how: ComboboxHow = {},
): Promise<FillOutcome> {
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
  // Two Options equal to the Value or its candidate words: no pick, and no
  // typeahead either, since the page offers both.
  let ambiguous = false
  // The Options the menu showed on the open gesture, before anything was
  // typed: what the page offers, reported with the outcome. A list filtered by
  // our own typing is not that list, so the typeahead never updates it.
  let offered: string[] = []
  const waitForHit = async (waitMs: number, breakOnOptions: boolean, readsOffer = false): Promise<HTMLElement | null> => {
    const deadline = Date.now() + waitMs
    for (;;) {
      const m = lookup()
      sawListbox = sawListbox || m.mounted
      const texts = m.options.map((o) => o.textContent ?? '')
      if (readsOffer || (how.search === true && texts.length > 0)) offered = wordings(texts)
      // Exact tier: the one Option equal to the Value or a candidate word
      // (#26). Candidate words match by equality only, never by the
      // substring tier below.
      const exact = how.pick === undefined ? matchOption(texts, value, candidates) : how.pick(texts)
      if (exact.found === 'many') { ambiguous = true; return null }
      const key = optionsKey(m.options)
      const settled = key === prevOptionsKey
      prevOptionsKey = key
      if (exact.found === 'one' && (how.search !== true || settled)) return m.options[exact.index]!
      // A search's pick awaiting its second, identical poll.
      const pendingPick = exact.found === 'one'

      // B1b ladder. Ambiguity (or a too-short target) fails closed: clicking
      // one of several substring candidates would be a guess, and a wrong
      // option is worse than asking. A unique candidate is only RETURNED once
      // it survives two consecutive polls unchanged — `settled` below.
      let uniquePartial: HTMLElement | null = null
      if (how.pick === undefined && target.length >= MIN_SUBSTRING_LEN) {
        const partial = m.options.filter((o) => norm(o.textContent ?? '').includes(target))
        uniquePartial = partial.length === 1 ? partial[0]! : null
      }
      if (uniquePartial !== null && settled) return uniquePartial

      // Options are mounted and there is no candidate even awaiting its settle
      // confirmation: waiting longer adds nothing — the typeahead is the next
      // move. A PENDING unique candidate (not yet settled) is worth one more
      // poll even on this fast path, so it is exempted from the early break.
      if (breakOnOptions && m.options.length > 0 && uniquePartial === null && !pendingPick) return null
      if (Date.now() >= deadline) return null
      await wait(COMBOBOX_POLL_MS)
    }
  }

  const failClosed = async (reason: string): Promise<FillOutcome> => {
    // Restore FIRST: B1a always types, so the restore write is itself an input
    // event — fired after Escape it would re-open the dropdown we just closed.
    // Order: restore ('' only ever written when '' WAS the snapshot) → one
    // frame for the page to react → Escape + blur, the way a user backs out.
    if (input !== null && snapshot !== null && input.value !== snapshot) setNativeValue(input, snapshot)
    await nextFrame()
    backOut(el)
    return withOptions({ ok: false, reason }, offered)
  }
  // B1d: "never opened/attributed" is a different user problem than "your value
  // is not in the list" — the hint copy diverges (Plan-3 Decision 6 debt).
  const noHitReason = (): string => (sawListbox ? 'no-matching-option' : 'combobox-no-listbox')

  let hit = await waitForHit(COMBOBOX_WAIT_MS, true, true)
  if (hit === null) {
    if (ambiguous) return failClosed('no-matching-option')
    if (input === null || value === '' || isProse(value)) return failClosed(noHitReason())
    // B1a: ALWAYS drive the typeahead when typing is possible.
    input.focus()
    setNativeValue(input, value)
    hit = await waitForHit(COMBOBOX_TYPE_WAIT_MS, false)
    if (hit === null) return failClosed(ambiguous ? 'no-matching-option' : noHitReason())
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
  // Whether the Option was selected before the commit: the phone Fill takes a
  // change to selected as evidence on a non-input control.
  const preSelected = hit.getAttribute('aria-selected')
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
    if (norm(shown) === optionText) return withOptions({ ok: true, committed: shown === value ? null : shown }, offered)
    if (how.shows !== undefined) {
      const selected = preSelected !== 'true' && hit.getAttribute('aria-selected') === 'true'
      if (selected || how.shows()) return withOptions({ ok: true, committed: null }, offered)
    }
    return failClosed('no-commit')
  }
  let committed: string | null = null
  if (input.value === '') {
    // (a) C2 (Greenhouse): react-select CLEARS its input and renders the
    // Option in a visible value container.
    committed = visibleCommittedText(input, optionText, preTexts)
    // A phone's country dropdown may show a flag and the code, never the Option's text.
    if (committed === null && how.shows?.() === true) committed = value
  } else if (norm(input.value) === optionText && input.value !== preCommit) {
    // (b) The widget rewrote the input into the Option's text.
    committed = input.value
  } else if (norm(input.value) === optionText) {
    // (c) The input already held the Option's text. Only a blur tells a commit
    // (kept) from a discarded typeahead (cleared).
    if (document.activeElement !== input) input.focus()
    blurHeard(input)
    await nextFrame()
    if (norm(input.value) === optionText) committed = input.value
  }
  if (committed === null) return failClosed('no-commit')
  return withOptions({ ok: true, committed: committed === value ? null : committed }, offered)
}

/* ------------------------------------------------- the phone's country selector */

/**
 * True when a country selector shows the phone's country: a native select by
 * its selected Option; a button by its title, accessible name or text (an
 * intl-tel-input button reads "Change country, selected X (+NN)"); a typeahead
 * by the visible text around it, inside the widest wrapper that holds no other
 * control, never by what is typed in its input.
 */
function showsCountry(sel: Element, parts: PhoneParts): boolean {
  if (sel instanceof HTMLSelectElement) return namesPhoneCountry(sel.selectedOptions[0]?.textContent ?? '', parts)
  if (!(sel instanceof HTMLInputElement)) {
    const code = new RegExp(`\\+\\s?${parts.callingCode}(?!\\d)`)
    const attrs = [sel.getAttribute('title') ?? '', sel.getAttribute('aria-label') ?? '']
    return attrs.some((t) => namesPhoneCountry(t, parts) || code.test(t)) || namesPhoneCountry((sel.textContent ?? '').trim(), parts)
  }
  let scope: Element | null = null
  for (let a = sel.parentElement, depth = 0; a !== null && depth < 5 && isSoleControl(a, sel); depth++, a = a.parentElement) scope = a
  if (scope === null) return false
  return Array.from(scope.querySelectorAll<HTMLElement>('*')).some((node) =>
    node !== sel && node.children.length === 0
    && node.closest('[role="listbox"], label, legend') === null
    && !isDisplayHidden(node)
    && namesPhoneCountry((node.textContent ?? '').trim(), parts))
}

/** Sets one country selector to the phone's country and checks the page kept it. */
async function setCountrySelector(sel: Element, parts: PhoneParts): Promise<FillOutcome> {
  // Already on the phone's country (a page that geolocates, or syncs one
  // selector from the other): nothing to set.
  if (showsCountry(sel, parts)) return { ok: true }
  const pick = (texts: readonly string[]): OptionMatch => pickCountryOption(texts, parts)
  if (sel instanceof HTMLSelectElement) {
    const options = Array.from(sel.options)
    const m = pick(options.map((o) => o.textContent ?? ''))
    if (m.found !== 'one') return { ok: false, reason: 'no-matching-option' }
    const opt = options[m.index]!
    setNativeValue(sel, opt.value)
    return opt.selected ? { ok: true } : { ok: false, reason: 'no-commit' }
  }
  // The typeahead, when the open list names no Option, searches the country's first name.
  return fillCombobox(sel, parts.countryNames[0] ?? '', [], { pick, shows: () => showsCountry(sel, parts) })
}

/** A selector's failure as the phone Field reports it. */
const phoneReason = (reason: string): string =>
  reason === 'no-matching-option' ? 'phone-country-no-match'
  : reason === 'listbox-left-open' ? reason
  : 'phone-country-not-set'

/**
 * The phone Field with country selectors attached: each selector is set to the
 * phone's country and checked, then the national number is typed. The parts
 * come with the Fill (Resolution.phone); a Value the user edited travels
 * without them and is taken apart here, with no stored country to prefer. A
 * selector that cannot be set fails the Field and leaves the phone box as it
 * was. The Options of a selector are never reported: they are not the phone
 * Field's.
 */
async function fillPhone(el: HTMLInputElement, value: string, selectors: readonly Element[], given: PhoneParts | undefined): Promise<FillOutcome> {
  const parts = given ?? phoneParts(value, null)
  if (parts === null) return { ok: false, reason: 'phone-country-unknown' }
  const snapshot = el.value
  const restore = (): void => { if (el.value !== snapshot) setNativeValue(el, snapshot) }
  for (const sel of selectors) {
    const out = await setCountrySelector(sel, parts)
    if (!out.ok) { restore(); return { ok: false, reason: phoneReason(out.reason) } }
  }
  const typed = fillTextual(el, parts.nationalNumber)
  if (!typed.ok) { restore(); return typed }
  return { ok: true }
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

/** The parts a Fill is given beside the Value (Resolution.phone and Resolution.city). */
export interface FillParts {
  phone?: PhoneParts
  city?: CityParts
}

/**
 * A city typeahead: the city alone is typed, and the result that names the
 * city and the stored country is committed with the checks every dropdown Fill
 * has. Several such results, or none, are a miss that returns the results and
 * clears the typed text.
 */
const fillCityTypeahead = (el: Element, city: string, parts: CityParts): Promise<FillOutcome> =>
  fillCombobox(el, city, [], { pick: (texts) => pickCityOption(texts, city, parts), search: true })

/**
 * `candidates` are the candidate words of the Value (Resolution.candidates):
 * on a choice Control the Fill picks the one Option equal to the Value or to
 * one of them. A text Control, a lone checkbox and a checkbox group ignore them.
 */
export async function fillOne(
  el: Element, value: string, candidates: readonly string[] = [], parts: FillParts = {},
): Promise<FillOutcome> {
  // Hard rail: this extension NEVER activates a submit control.
  if (el.tagName === 'BUTTON' || (el instanceof HTMLInputElement && ['submit', 'button', 'reset', 'image'].includes(el.type))) {
    return { ok: false, reason: 'unsupported-widget' }
  }
  if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
    return parts.city === undefined ? fillCombobox(el, value, candidates) : fillCityTypeahead(el, value, parts.city)
  }
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
    if (choice !== null) return withOptions(await fillChoice(el, choice, value, candidates), wordings(choice.options))
  }
  if (el instanceof HTMLSelectElement) return fillSelect(el, value, candidates)
  if (el instanceof HTMLInputElement && el.type === 'radio') return fillRadioGroup(el, value, candidates)
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return fillCheckbox(el, value)
  if (el instanceof HTMLInputElement && el.type === 'file') return { ok: false, reason: 'file-needs-blob' }
  // A phone box with its country selector: the selector is set, then the national number typed.
  const attached = phoneSelectorsOf(el)
  if (el instanceof HTMLInputElement && attached !== null) return fillPhone(el, value, attached.selectors, parts.phone)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return fillTextual(el, value)
  return { ok: false, reason: 'unsupported-widget' }
}

/**
 * A read (ticket #34): the Control's Options, and nothing on the page changed.
 * A dropdown is opened, read and closed through the dropdown Fill itself, with
 * a pick that takes no Option and no Value to type: the same foreign-menu
 * check before it opens, the same attributable listbox, the same restore and
 * Escape on the way out. A dropdown that shows nothing until text is typed
 * reports none. A radio group, a checkbox group, a choice widget and a native
 * select are read where they stand, with no click and no change. Any other
 * Control has no Options to read. The outcome is always a miss whose reason is
 * OPTIONS_READ, unless a foreign menu would not close.
 */
export async function readOne(el: Element): Promise<FillOutcome> {
  const read = (options: readonly string[]): FillOutcome => withOptions({ ok: false, reason: OPTIONS_READ }, wordings(options))
  if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
    const out = await fillCombobox(el, '', [], { pick: () => ({ found: 'none' }) })
    if (!out.ok && out.reason === 'listbox-left-open') return out
    return read(out.options ?? [])
  }
  const group = groupBoxesOf(el)
  if (group !== null) return read(group.map(optionLabelOf))
  if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox') && selfHidden(defaultMeasure(el))) {
    const choice = detectChoice(el)
    if (choice !== null) return read(choice.options)
  }
  if (el instanceof HTMLSelectElement) return read(Array.from(el.options, (o) => o.textContent ?? ''))
  if (el instanceof HTMLInputElement && el.type === 'radio') return read(radioMembersOf(el).map(optionLabelOf))
  return read([])
}

/** A Control a choice Fill drives: a dropdown, a native select, a radio or a
 *  checkbox (choice widgets and checkbox groups ride on the latter two), or a
 *  phone box whose country selector the Fill opens. */
function isChoiceControl(el: Element): boolean {
  return phoneSelectorsOf(el) !== null
    || el.getAttribute('role') === 'combobox'
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
  fills: { handle: FieldHandle; value?: string; candidates?: readonly string[]; phone?: PhoneParts; city?: CityParts }[],
): Promise<Omit<FillReport, 'epoch'>> {
  const filled: FillReport['filled'] = []
  const failed: FillReport['failed'] = []
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
    const parts: FillParts = { ...(f.phone === undefined ? {} : { phone: f.phone }), ...(f.city === undefined ? {} : { city: f.city }) }
    // An entry with no Value is a read: the Options, and nothing changed.
    const out = f.value === undefined ? await readOne(el) : await fillOne(el, f.value, f.candidates ?? [], parts)
    const options = out.options === undefined ? {} : { options: out.options }
    if (out.ok) filled.push({ handle: f.handle, committed: out.committed ?? null, ...options })
    else failed.push({ handle: f.handle, reason: out.reason, ...options })
  }
  return { filled, failed }
}
