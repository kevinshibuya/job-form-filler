import { describe, it, expect, beforeEach } from 'vitest'
import { OPTIONS_READ, type EnumField } from '@jff/shared'
import { enumerateFields, type MeasureFn } from './enumerate'
import { fillFields } from './fill'

/**
 * Ticket #34 at the content-script seam (spec #6, testing decision 1): a Fill
 * entry sent with no Value reads the Control's Options and changes nothing on
 * the page. A dropdown is opened, read and closed; a radio group, a checkbox
 * group and a native select are read where they stand. The report carries the
 * Options as a miss does. Everything asserted is what the page shows, what it
 * was sent, or what the Fill report says.
 */

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 100, height: 20, clipped: false })
const scanPage = (): EnumField[] => enumerateFields({ root: document, epoch: 5, measure: allVisible }).fields
const handleOf = (f: EnumField) => ({ frameId: 0, fid: f.fid, epoch: 5 })

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

/** Every event of these types the page sees, anywhere below the body. */
function recordEvents(types: string[]): string[] {
  const seen: string[] = []
  for (const type of types) document.body.addEventListener(type, () => seen.push(type), true)
  return seen
}

/**
 * An EU work-authorization dropdown whose Options load when it opens, as on
 * the hosted Greenhouse form. Its input already holds a draft the read must
 * leave alone.
 */
function mountRegionDropdown(): HTMLInputElement {
  document.body.innerHTML = `
    <label for="eu">Are you authorized to work in the EU?</label>
    <input id="eu" role="combobox" aria-haspopup="listbox" aria-expanded="false">`
  const combo = document.getElementById('eu') as HTMLInputElement
  combo.addEventListener('click', () => {
    if (document.getElementById('menu') !== null) return
    combo.setAttribute('aria-expanded', 'true')
    combo.setAttribute('aria-controls', 'menu')
    const lb = document.createElement('div')
    lb.id = 'menu'
    lb.setAttribute('role', 'listbox')
    for (const name of ['Yes, in every EU country', 'Only in some EU countries', 'No']) {
      const o = document.createElement('div')
      o.setAttribute('role', 'option')
      o.textContent = name
      o.addEventListener('click', () => { combo.value = name; combo.setAttribute('aria-expanded', 'false'); lb.remove() })
      lb.appendChild(o)
    }
    document.body.appendChild(lb)
  })
  combo.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { document.getElementById('menu')?.remove(); combo.setAttribute('aria-expanded', 'false') }
  })
  return combo
}

describe('a Fill entry with no Value on a dropdown', () => {
  it('opens it, returns its Options, closes it and leaves the value as it was', async () => {
    const combo = mountRegionDropdown()
    const [f] = scanPage()
    combo.value = 'draft'
    const typed: string[] = []
    combo.addEventListener('input', () => typed.push(combo.value))
    const report = await fillFields(document, [{ handle: handleOf(f!) }])
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([{
      handle: handleOf(f!), reason: OPTIONS_READ,
      options: ['Yes, in every EU country', 'Only in some EU countries', 'No'],
    }])
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(combo.getAttribute('aria-expanded')).toBe('false')
    expect(combo.value).toBe('draft')
    expect(typed).toEqual([])
  })

  it('a dropdown that shows no Options until text is typed returns none, and nothing is typed into it', async () => {
    document.body.innerHTML = `
      <label for="city">City</label>
      <input id="city" role="combobox" aria-haspopup="listbox" aria-expanded="false">`
    const combo = document.getElementById('city') as HTMLInputElement
    const typed: string[] = []
    combo.addEventListener('input', () => typed.push(combo.value))
    const [f] = scanPage()
    const report = await fillFields(document, [{ handle: handleOf(f!) }])
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([{ handle: handleOf(f!), reason: OPTIONS_READ }])
    expect(typed).toEqual([])
    expect(combo.value).toBe('')
  })
})

describe('a Fill entry with no Value on a Control whose Options stand on the page', () => {
  it('a native select returns its Options and dispatches no change', async () => {
    document.body.innerHTML = `
      <label for="s">Do you require visa sponsorship in the EU?</label>
      <select id="s"><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select>`
    const select = document.getElementById('s') as HTMLSelectElement
    const [f] = scanPage()
    const events = recordEvents(['click', 'change', 'input'])
    const report = await fillFields(document, [{ handle: handleOf(f!) }])
    expect(report.failed).toEqual([{ handle: handleOf(f!), reason: OPTIONS_READ, options: ['Select...', 'Yes', 'No'] }])
    expect(events).toEqual([])
    expect(select.value).toBe('')
  })

  it('a radio group returns its Options and dispatches no click or change', async () => {
    document.body.innerHTML = `
      <fieldset><legend>Are you based in EMEA?</legend>
        <label><input type="radio" name="emea" value="y"> Yes</label>
        <label><input type="radio" name="emea" value="n"> No</label>
      </fieldset>`
    const [f] = scanPage()
    const events = recordEvents(['click', 'change', 'input'])
    const report = await fillFields(document, [{ handle: handleOf(f!) }])
    expect(report.failed).toEqual([{ handle: handleOf(f!), reason: OPTIONS_READ, options: ['Yes', 'No'] }])
    expect(events).toEqual([])
    expect([...document.querySelectorAll<HTMLInputElement>('input')].some((r) => r.checked)).toBe(false)
  })

  it('a checkbox group returns its Options and dispatches no click or change', async () => {
    document.body.innerHTML = `
      <fieldset><legend>Pronouns</legend>
        <label><input type="checkbox" name="pronouns" value="he"> He/him</label>
        <label><input type="checkbox" name="pronouns" value="they"> They/them</label>
        <label><input type="checkbox" name="pronouns" value="xe"> Xe/xem</label>
      </fieldset>`
    const fields = scanPage()
    const group = fields.find((f) => f.kind === 'checkboxgroup')
    expect(group).toBeDefined()
    const events = recordEvents(['click', 'change', 'input'])
    const report = await fillFields(document, [{ handle: handleOf(group!) }])
    expect(report.failed).toEqual([{ handle: handleOf(group!), reason: OPTIONS_READ, options: ['He/him', 'They/them', 'Xe/xem'] }])
    expect(events).toEqual([])
    expect([...document.querySelectorAll<HTMLInputElement>('input')].some((b) => b.checked)).toBe(false)
  })

  it('a text box has no Options to read and is left as it was', async () => {
    document.body.innerHTML = '<label for="t">Are you based in LATAM?</label><input id="t" value="kept">'
    const [f] = scanPage()
    const report = await fillFields(document, [{ handle: handleOf(f!) }])
    expect(report).toEqual({ filled: [], failed: [{ handle: handleOf(f!), reason: OPTIONS_READ }] })
    expect((document.getElementById('t') as HTMLInputElement).value).toBe('kept')
  })
})

describe('a read among Fills', () => {
  it('a read between two Fills changes nothing, and the Fills around it still fill', async () => {
    document.body.innerHTML = `
      <label for="a">First name</label><input id="a">
      <label for="s">Do you require visa sponsorship in the EU?</label>
      <select id="s"><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select>
      <label for="b">Last name</label><input id="b">`
    const [first, select, last] = scanPage()
    const report = await fillFields(document, [
      { handle: handleOf(first!), value: 'Ada' },
      { handle: handleOf(select!) },
      { handle: handleOf(last!), value: 'Lovelace' },
    ])
    expect(report.filled.map((x) => x.handle.fid)).toEqual([first!.fid, last!.fid])
    expect(report.failed).toEqual([{ handle: handleOf(select!), reason: OPTIONS_READ, options: ['Select...', 'Yes', 'No'] }])
    expect((document.getElementById('s') as HTMLSelectElement).value).toBe('')
  })
})
