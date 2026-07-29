import type { FieldHandle, FillReport } from '@jff/shared'
import { optionLabelOf, scopeOf } from './dom'
import { defaultMeasure, detectChoice, elementByFid, selfHidden, type ChoiceDetection } from './enumerate'

type FillOutcome = { ok: true } | { ok: false; reason: string }

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

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

function listboxOf(el: Element): Element | null {
  const scope = scopeOf(el)
  const owns = el.getAttribute('aria-owns') ?? el.getAttribute('aria-controls')
  if (owns !== null) {
    const first = owns.split(/\s+/)[0]
    if (first !== undefined) {
      const found = scope.querySelector(`[id="${first.replace(/"/g, '\\"')}"]`)
      if (found !== null) return found
    }
  }
  return el.parentElement?.querySelector('[role="listbox"]') ?? scope.querySelector('[role="listbox"]')
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function fillCombobox(el: Element, value: string): Promise<FillOutcome> {
  // Open it the way a user would: a real click. Options are usually rendered lazily.
  ;(el as HTMLElement).click()
  const target = norm(value)
  for (let attempt = 0; attempt < 10; attempt++) {
    const listbox = listboxOf(el)
    const options = listbox === null ? [] : Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]'))
    const hit = options.find((o) => norm(o.textContent ?? '') === target)
      ?? options.find((o) => norm(o.textContent ?? '').startsWith(target))
    if (hit !== undefined) { hit.click(); return { ok: true } }
    if (options.length > 0) return { ok: false, reason: 'no-matching-option' }
    await wait(50)
  }
  return { ok: false, reason: 'no-matching-option' }
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
  const filled: FieldHandle[] = []
  const failed: { handle: FieldHandle; reason: string }[] = []
  for (const f of fills) {
    const el = elementByFid(root, f.handle.fid)
    if (el === null) { failed.push({ handle: f.handle, reason: 'element-not-found' }); continue }
    const out = await fillOne(el, f.value)
    if (out.ok) filled.push(f.handle)
    else failed.push({ handle: f.handle, reason: out.reason })
  }
  return { filled, failed }
}
