import { describe, it, expect, beforeEach } from 'vitest'
import type { PhoneParts } from '@jff/shared'
import { enumerateFields, type MeasureFn } from './enumerate'
import { fillFields } from './fill'
import { loadRealFixture } from './fixtures/real'
import { isPhoneControl, phoneSelectorsOf, pickCountryOption } from './phoneSelector'

// Ticket #30: the country selector beside a phone box is part of the phone
// Field. The content script runs over fixture pages (spec #6, testing decision
// 1); the persona is Ada Lovelace, phone +1 555 0100.

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })
beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

// What the Native host sends for +15550100 (phoneParts.test.ts).
const US_NAMES = ['United States', 'United States of America', 'US', 'USA', 'U.S.', 'U.S.A.', 'Estados Unidos', 'Estados Unidos da América', 'Estados Unidos da America', 'EUA']
const US: PhoneParts = { callingCode: '1', nationalNumber: '5550100', countryNames: US_NAMES }
const CANADA: PhoneParts = { callingCode: '1', nationalNumber: '5550100', countryNames: ['Canada', 'Canadá'] }
const NO_COUNTRY: PhoneParts = { callingCode: '1', nationalNumber: '5550100', countryNames: [] }

const h = (fid: number) => ({ frameId: 0, fid, epoch: 9 })
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const scan = () => enumerateFields({ root: document, epoch: 9, measure: allVisible }).fields
const phoneFid = (): number => scan().find((f) => f.idAttr === 'phone')!.fid
const fillPhone = (parts?: PhoneParts) =>
  fillFields(document, [{ handle: h(phoneFid()), value: '+15550100', ...(parts === undefined ? {} : { phone: parts }) }])

/** intl-tel-input ships the rule that hides its closed list; a capture drops the stylesheet. */
function hideLikeThePage(): void {
  const style = document.createElement('style')
  style.textContent = '.iti__hide { display: none; }'
  document.head.appendChild(style)
}

/**
 * A react-select-like dropdown over an existing input: the full open gesture
 * mounts a menu of `options`; clicking one clears the input, shows the Option
 * in `holder` and unmounts the menu. With `keeps: false` the page ignores the
 * click and the menu stays.
 */
function driveDropdown(input: HTMLInputElement, holder: HTMLElement, options: string[], keeps = true): string[] {
  const picked: string[] = []
  const close = (): void => { document.getElementById(`${input.id}-menu`)?.remove(); input.setAttribute('aria-expanded', 'false') }
  input.addEventListener('click', () => {
    if (document.getElementById(`${input.id}-menu`) !== null) return
    input.setAttribute('aria-expanded', 'true')
    input.setAttribute('aria-controls', `${input.id}-menu`)
    const lb = document.createElement('div')
    lb.id = `${input.id}-menu`
    lb.setAttribute('role', 'listbox')
    for (const text of options) {
      const o = document.createElement('div')
      o.setAttribute('role', 'option')
      o.textContent = text
      o.addEventListener('click', () => {
        if (!keeps) return
        picked.push(text)
        input.value = ''
        holder.textContent = text
        close()
      })
      lb.appendChild(o)
    }
    input.parentElement!.appendChild(lb)
  })
  return picked
}

/**
 * intl-tel-input's own behaviour over the captured flag dropdown: the flag
 * button opens the hidden list, and a click on a country marks it selected,
 * names it on the button and hides the list again.
 */
function driveFlagList(): void {
  const button = document.querySelector<HTMLButtonElement>('.iti__selected-country')!
  const dropdown = byId('iti-0__dropdown-content')
  button.addEventListener('click', () => {
    dropdown.classList.remove('iti__hide')
    button.setAttribute('aria-expanded', 'true')
  })
  byId('iti-0__country-listbox').addEventListener('click', (e) => {
    const item = (e.target as Element).closest<HTMLElement>('.iti__country')
    if (item === null) return
    for (const li of Array.from(document.querySelectorAll('.iti__country'))) li.setAttribute('aria-selected', 'false')
    item.setAttribute('aria-selected', 'true')
    const name = item.querySelector('.iti__country-name')!.textContent!
    button.setAttribute('title', name)
    button.setAttribute('aria-label', `${name}: +${item.dataset['dialCode']!}`)
    dropdown.classList.add('iti__hide')
    button.setAttribute('aria-expanded', 'false')
  })
}

/** A phone box paired with a Country dropdown in one fieldset, as on the hosted Greenhouse form. */
function pairedPage(options: string[], { keeps = true, prefill = '' } = {}): string[] {
  document.body.innerHTML = `
    <fieldset>
      <legend>Phone</legend>
      <label id="country-label" for="country">Country</label>
      <div><div id="shown"></div><input id="country" role="combobox" aria-haspopup="true" aria-expanded="false" aria-labelledby="country-label"></div>
      <label for="phone">Phone</label>
      <input id="phone" type="tel">
    </fieldset>`
  byId<HTMLInputElement>('phone').value = prefill
  return driveDropdown(byId('country'), byId('shown'), options, keeps)
}

describe('recognising a phone box and its country selector', () => {
  it('a tel input is a phone box, and so is a text input named phone; an email box is not', () => {
    document.body.innerHTML = '<input id="a" type="tel"><input id="b" name="phone_number"><input id="c" type="email" name="phone">'
    expect(isPhoneControl(byId('a'))).toBe(true)
    expect(isPhoneControl(byId('b'))).toBe(true)
    expect(isPhoneControl(byId('c'))).toBe(false)
  })

  it('greenhouse-hosted-a and greenhouse-hosted-b: the Country dropdown paired with the phone box in its fieldset', () => {
    for (const name of ['greenhouse-hosted-a', 'greenhouse-hosted-b']) {
      loadRealFixture(name)
      expect(phoneSelectorsOf(byId('phone'))?.selectors).toEqual([byId('country')])
    }
  })

  it('greenhouse-self-id and greenhouse-accommodation: the paired Country dropdown and the flag dropdown inside the phone box\'s wrapper', () => {
    for (const name of ['greenhouse-self-id', 'greenhouse-accommodation']) {
      loadRealFixture(name)
      const attached = phoneSelectorsOf(byId('phone'))!
      expect(attached.selectors).toEqual([byId('country'), document.querySelector('.iti__selected-country')])
      expect(attached.internals).toContain(byId('iti-0__search-input'))
    }
  })

  it('a phone box with no selector beside it has none attached', () => {
    document.body.innerHTML = '<label for="phone">Phone</label><input id="phone" type="tel"><label for="c">Country</label><select id="c"><option>Canada</option></select>'
    expect(phoneSelectorsOf(byId('phone'))).toBeNull()
  })

  it('a fieldset with a phone box, a Country dropdown and a third control attaches nothing', () => {
    document.body.innerHTML = `
      <fieldset><legend>Contact</legend>
        <label for="c">Country</label><select id="c"><option>Canada</option></select>
        <label for="city">City</label><input id="city">
        <label for="phone">Phone</label><input id="phone" type="tel">
      </fieldset>`
    expect(phoneSelectorsOf(byId('phone'))).toBeNull()
  })
})

describe('the Option for the phone\'s country', () => {
  it('names the country by any of its names, with or without a calling code beside the name', () => {
    expect(pickCountryOption(['Canada +1', 'United States +1'], US)).toEqual({ found: 'one', index: 1 })
    expect(pickCountryOption(['Canada+1', 'United States+1'], CANADA)).toEqual({ found: 'one', index: 0 })
    expect(pickCountryOption(['Brasil', 'Estados Unidos (+1)'], US)).toEqual({ found: 'one', index: 1 })
    expect(pickCountryOption(['Canada', 'United States'], US)).toEqual({ found: 'one', index: 1 })
  })

  it('with no country, or no Option naming it, the one Option that carries the calling code', () => {
    expect(pickCountryOption(['Brazil +55', 'Canada +1', 'Portugal +351'], NO_COUNTRY)).toEqual({ found: 'one', index: 1 })
    expect(pickCountryOption(['Brazil +55', 'Canada +1'], US)).toEqual({ found: 'one', index: 1 })
  })

  it('two Options with the calling code, and none naming the country: no pick', () => {
    expect(pickCountryOption(['United States +1', 'Canada +1'], NO_COUNTRY)).toEqual({ found: 'many' })
    expect(pickCountryOption(['Brazil +55', 'Barbados +1246'], NO_COUNTRY)).toEqual({ found: 'none' })
  })
})

describe('filling the phone Field sets its country selector, then types the national number', () => {
  it('a selector offering "United States +1" and "Canada +1" is set to the United States, and 5550100 is typed into the phone box', async () => {
    const picked = pairedPage(['Canada +1', 'United States +1'])
    const report = await fillPhone(US)
    expect(report).toMatchObject({ filled: [{ committed: null }], failed: [] })
    expect(report.filled[0]!.options).toBeUndefined()
    expect(picked).toEqual(['United States +1'])
    expect(byId('shown').textContent).toBe('United States +1')
    expect(byId<HTMLInputElement>('phone').value).toBe('5550100')
  })

  it('the same phone with a stored country of Canada sets the selector to Canada', async () => {
    const picked = pairedPage(['United States +1', 'Canada +1'])
    const report = await fillPhone(CANADA)
    expect(report.failed).toEqual([])
    expect(picked).toEqual(['Canada +1'])
    expect(byId<HTMLInputElement>('phone').value).toBe('5550100')
  })

  it('with a stored country whose calling code is not the phone\'s, two Options for +1 fail the phone Field with a reason, the phone box as it was', async () => {
    const picked = pairedPage(['United States +1', 'Canada +1'], { prefill: '555' })
    const report = await fillPhone(NO_COUNTRY)
    expect(report).toMatchObject({ filled: [], failed: [{ reason: 'phone-country-no-match' }] })
    expect(picked).toEqual([])
    expect(byId<HTMLInputElement>('phone').value).toBe('555')
  })

  it('a selector that does not keep the country fails the phone Field with a reason, and the phone box is unchanged', async () => {
    pairedPage(['United States +1', 'Canada +1'], { keeps: false, prefill: '555' })
    const report = await fillPhone(US)
    expect(report).toMatchObject({ filled: [], failed: [{ reason: 'phone-country-not-set' }] })
    expect(byId<HTMLInputElement>('phone').value).toBe('555')
  }, 10_000)

  it('a Fill whose Value was edited, sent without parts, takes the parts from the Value itself', async () => {
    const picked = pairedPage(['Brazil +55', 'Canada +1'])
    const report = await fillPhone()
    expect(report.failed).toEqual([])
    expect(picked).toEqual(['Canada +1'])
    expect(byId<HTMLInputElement>('phone').value).toBe('5550100')
  })

  it('a phone box with no selector receives +15550100', async () => {
    document.body.innerHTML = '<label for="phone">Phone</label><input id="phone" type="tel">'
    const report = await fillPhone(US)
    expect(report).toMatchObject({ filled: [{ committed: null }], failed: [] })
    expect(byId<HTMLInputElement>('phone').value).toBe('+15550100')
  })

  it('greenhouse-self-id: the flag dropdown is set to the United States and read back, and its hidden list fails no Fill as listbox-left-open', async () => {
    loadRealFixture('greenhouse-self-id')
    hideLikeThePage()
    driveFlagList()
    const country = byId<HTMLInputElement>('country')
    const picked = driveDropdown(country, document.querySelector<HTMLElement>('#react-select-country-placeholder')!, ['Canada +1', 'United States +1'])
    const report = await fillPhone(US)
    expect(report.failed).toEqual([])
    expect(picked).toEqual(['United States +1'])
    const us = byId('iti-0__item-us')
    expect(us.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('.iti__selected-country')!.getAttribute('title')).toBe('United States')
    expect(byId('iti-0__dropdown-content').classList.contains('iti__hide')).toBe(true)
    expect(byId<HTMLInputElement>('phone').value).toBe('5550100')
  }, 10_000)
})
