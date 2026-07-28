import type { FieldHandle, FillReport } from '@jff/shared'
import { optionLabelOf, scopeOf } from './dom'
import { elementByFid } from './enumerate'

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
