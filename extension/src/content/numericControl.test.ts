import { describe, it, expect, beforeEach } from 'vitest'
import { enumerateFields, type MeasureFn } from './enumerate'
import { fillFields } from './fill'

// Ticket #33: Enumeration tells Resolution that a Control takes only numbers,
// so a salary is offered to it as the amount alone. The content script runs
// over a fixture page (spec #6, testing decision 1).

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })
beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

function scan() {
  const { fields } = enumerateFields({ root: document, epoch: 3, measure: allVisible })
  return (label: string) => {
    const f = fields.find((x) => x.label === label)
    if (f === undefined) throw new Error(`no Field labelled ${label}`)
    return f
  }
}

describe('a Control that takes only numbers', () => {
  it('Enumeration marks a number input as taking only numbers, and a plain text box as not', () => {
    document.body.innerHTML = `
      <form>
        <label for="a">Desired salary</label><input id="a" type="number" />
        <label for="b">Salary expectation</label><input id="b" type="text" />
        <label for="c">Expected pay</label><input id="c" />
      </form>`
    const byLabel = scan()
    expect(byLabel('Desired salary')).toMatchObject({ kind: 'text', numeric: true })
    expect(byLabel('Salary expectation')).toMatchObject({ kind: 'text', numeric: false })
    expect(byLabel('Expected pay')).toMatchObject({ kind: 'text', numeric: false })
  })

  it('a text box that asks for a numeric keyboard takes only numbers too', () => {
    document.body.innerHTML = `
      <label for="a">Annual salary</label><input id="a" type="text" inputmode="numeric" />
      <label for="b">Monthly salary</label><input id="b" type="text" inputmode="decimal" />
      <label for="c">Your email</label><input id="c" type="email" inputmode="email" />`
    const byLabel = scan()
    expect(byLabel('Annual salary').numeric).toBe(true)
    expect(byLabel('Monthly salary').numeric).toBe(true)
    expect(byLabel('Your email').numeric).toBe(false)
  })

  it('no Control other than a text box is marked either way', () => {
    document.body.innerHTML = `
      <label for="s">Currency</label><select id="s"><option>EUR</option><option>USD</option></select>
      <label for="t">Anything else?</label><textarea id="t"></textarea>`
    const byLabel = scan()
    expect('numeric' in byLabel('Currency')).toBe(false)
    expect('numeric' in byLabel('Anything else?')).toBe(false)
  })

  it('a number input filled with the amount holds it on the page', async () => {
    document.body.innerHTML = '<label for="a">Desired salary</label><input id="a" type="number" />'
    const f = scan()('Desired salary')
    const report = await fillFields(document, [{ handle: { frameId: 0, fid: f.fid, epoch: 3 }, value: '90000' }])
    expect(report.failed).toEqual([])
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('90000')
  })
})
