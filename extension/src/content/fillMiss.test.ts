import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { enumerateFields, type MeasureFn } from './enumerate'
import { fillFields } from './fill'

/**
 * Ticket #28 at the content-script seam (spec #6, testing decision 1): a Scan
 * opens no menu (ADR 0009), and a Fill of a choice Control reports the Options
 * it read on the page, on a hit and on a miss, so the Side panel can offer them
 * as a picker. Everything asserted is what the page shows or what the Fill
 * report says.
 */

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 100, height: 20, clipped: false })
const h = (fid: number) => ({ frameId: 0, fid, epoch: 5 })
const scanPage = () => enumerateFields({ root: document, epoch: 5, measure: allVisible })

const PROSE = 'I have spent the last six years building data pipelines for analytical engines, and I would bring that experience to your team from day one.'

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

/**
 * A Yes/No dropdown whose Options load when it opens, as on the hosted
 * Greenhouse form: nothing is mounted until the open gesture, and a click on an
 * Option commits it into the input and closes the menu. `events` records every
 * event the page sees on the box; `typed` every input event.
 */
function mountYesNoDropdown(): { combo: HTMLInputElement; events: string[]; typed: string[] } {
  document.body.innerHTML = `
    <label for="auth">Are you legally authorized to work in the country of this role?</label>
    <input id="auth" role="combobox" aria-haspopup="listbox" aria-expanded="false">`
  const combo = document.getElementById('auth') as HTMLInputElement
  const events: string[] = []
  const typed: string[] = []
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'focus', 'keydown', 'input']) {
    combo.addEventListener(type, () => events.push(type))
  }
  combo.addEventListener('input', () => typed.push(combo.value))
  combo.addEventListener('click', () => {
    if (document.getElementById('menu') !== null) return
    combo.setAttribute('aria-expanded', 'true')
    combo.setAttribute('aria-controls', 'menu')
    const lb = document.createElement('div')
    lb.id = 'menu'
    lb.setAttribute('role', 'listbox')
    for (const name of ['Yes', 'No']) {
      const o = document.createElement('div')
      o.setAttribute('role', 'option')
      o.textContent = name
      o.addEventListener('click', () => {
        combo.value = name
        combo.setAttribute('aria-expanded', 'false')
        lb.remove()
      })
      lb.appendChild(o)
    }
    document.body.appendChild(lb)
  })
  combo.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { document.getElementById('menu')?.remove(); combo.setAttribute('aria-expanded', 'false') }
  })
  return { combo, events, typed }
}

describe('a Scan opens no menu', () => {
  it('Enumeration dispatches no event to a dropdown, and the Field has no Options', () => {
    const { events } = mountYesNoDropdown()
    const { fields } = scanPage()
    expect(events).toEqual([])
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ kind: 'combobox', options: [] })
  })
})

describe('the content script rejects the removed message', () => {
  type Listener = (raw: unknown, sender: unknown, reply: (r: unknown) => void) => boolean
  let listener: Listener

  beforeAll(async () => {
    const listeners: Listener[] = []
    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { onMessage: { addListener: (l: Listener) => listeners.push(l) }, sendMessage: vi.fn() },
    }
    delete (window as { __jffLoaded?: boolean }).__jffLoaded
    await import('./index')
    listener = listeners[0]!
  })

  const send = (raw: unknown): Promise<unknown> => new Promise((resolve) => { listener(raw, {}, resolve) })

  it('answers the message that opened dropdowns for a Scan as it answers any unknown one, and opens nothing', async () => {
    const { events } = mountYesNoDropdown()
    expect(await send({ type: 'JFF_SCAN', epoch: 2 })).toMatchObject({ ok: true })
    const unknown = await send({ type: 'JFF_NOPE', epoch: 2 })
    expect(await send({ type: 'JFF_HARVEST', epoch: 2, fids: [0] })).toEqual(unknown)
    expect(unknown).toEqual({ ok: false, error: 'bad_message' })
    expect(events).toEqual([])
  })
})

describe('a Fill of a choice Control reports the Options it read', () => {
  it('a dropdown offering "Yes" and "No" with a Value that matches neither fails as no-matching-option and returns both Options', async () => {
    const { combo } = mountYesNoDropdown()
    scanPage()
    const report = await fillFields(document, [{ handle: h(0), value: 'Maybe later' }])
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([{ handle: h(0), reason: 'no-matching-option', options: ['Yes', 'No'] }])
    expect(combo.value).toBe('')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  }, 10_000)

  it('the same dropdown filled with "No" commits it and still returns both Options', async () => {
    const { combo } = mountYesNoDropdown()
    scanPage()
    const report = await fillFields(document, [{ handle: h(0), value: 'No' }])
    expect(report).toEqual({ filled: [{ handle: h(0), committed: null, options: ['Yes', 'No'] }], failed: [] })
    expect(combo.value).toBe('No')
  })

  it('a paragraph of prose is never typed into a dropdown: the Fill misses with the Options and the box never changed', async () => {
    const { combo, typed } = mountYesNoDropdown()
    scanPage()
    const report = await fillFields(document, [{ handle: h(0), value: PROSE }])
    expect(report.failed).toEqual([{ handle: h(0), reason: 'no-matching-option', options: ['Yes', 'No'] }])
    expect(typed).toEqual([])
    expect(combo.value).toBe('')
  })

  it('a native select that offers no matching Option returns its Options', async () => {
    document.body.innerHTML = `
      <label for="s">Do you require visa sponsorship?</label>
      <select id="s"><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select>`
    scanPage()
    const report = await fillFields(document, [{ handle: h(0), value: PROSE }])
    expect(report.failed).toEqual([{ handle: h(0), reason: 'no-matching-option', options: ['Select...', 'Yes', 'No'] }])
    expect((document.getElementById('s') as HTMLSelectElement).value).toBe('')
  })

  it('a radio group that offers no matching Option returns its Options', async () => {
    document.body.innerHTML = `
      <fieldset><legend>Willing to relocate?</legend>
        <label><input type="radio" name="reloc" value="y"> Yes</label>
        <label><input type="radio" name="reloc" value="n"> No</label>
      </fieldset>`
    scanPage()
    const report = await fillFields(document, [{ handle: h(0), value: 'Perhaps' }])
    expect(report.failed).toEqual([{ handle: h(0), reason: 'no-matching-option', options: ['Yes', 'No'] }])
  })

  it('a text box reports no Options', async () => {
    document.body.innerHTML = '<label for="t">City</label><input id="t">'
    scanPage()
    const report = await fillFields(document, [{ handle: h(0), value: 'London' }])
    expect(report).toEqual({ filled: [{ handle: h(0), committed: null }], failed: [] })
  })
})
