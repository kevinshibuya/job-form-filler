import { describe, it, expect, beforeEach } from 'vitest'
import type { CityParts } from '@jff/shared'
import { pickCityOption } from './cityTypeahead'
import { enumerateFields, type MeasureFn } from './enumerate'
import { fillFields } from './fill'

// Ticket #32: a city typeahead is given the city alone, and the Fill picks the
// result that names both the city and the stored country. The content script
// runs over fixture pages (spec #6, testing decision 1). The cities and
// countries are not the maintainer's.

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })
beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

// What the Native host sends beside a city of Cambridge (cityField.test.ts).
const UK: CityParts = { countryNames: ['United Kingdom', 'UK', 'Great Britain', 'Reino Unido', 'Grã-Bretanha', 'Gra-Bretanha'] }
const US: CityParts = { countryNames: ['United States', 'United States of America', 'US', 'USA', 'U.S.', 'U.S.A.', 'Estados Unidos', 'EUA'] }
const NO_COUNTRY: CityParts = { countryNames: [] }

/**
 * A city typeahead: the open gesture shows nothing; every keystroke searches
 * `places` for the typed text and mounts the results a moment later. A click
 * on a result writes it into the box and unmounts the menu. `typed` records
 * every text the page was asked to search. With `rival`, a search that answers
 * in pages: one more result mounts right after the Fill first reads the
 * results, so the next poll always sees it, whatever the machine's load.
 */
function mountCityTypeahead(places: string[], rival?: string): { box: HTMLInputElement; typed: string[]; fid: number } {
  document.body.innerHTML = `
    <label for="city">City</label>
    <div class="wrap"><input id="city" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" /></div>`
  const box = document.getElementById('city') as HTMLInputElement
  const typed: string[] = []
  const close = (): void => { document.getElementById('city-menu')?.remove(); box.setAttribute('aria-expanded', 'false') }
  box.addEventListener('input', () => {
    close()
    const q = box.value.trim().toLowerCase()
    if (q === '') return
    typed.push(box.value)
    setTimeout(() => {
      if (box.value.trim().toLowerCase() !== q) return
      const lb = document.createElement('div')
      lb.id = 'city-menu'
      lb.setAttribute('role', 'listbox')
      const option = (text: string): HTMLElement => {
        const o = document.createElement('div')
        o.setAttribute('role', 'option')
        o.textContent = text
        o.addEventListener('click', () => { box.value = text; close() })
        return o
      }
      for (const text of places.filter((p) => p.toLowerCase().startsWith(q))) lb.appendChild(option(text))
      const first = lb.firstElementChild
      if (rival !== undefined && first !== null) {
        let read = false
        Object.defineProperty(first, 'textContent', {
          configurable: true,
          get: () => {
            if (!read) { read = true; queueMicrotask(() => { if (lb.isConnected) lb.appendChild(option(rival)) }) }
            return first.firstChild?.nodeValue ?? ''
          },
        })
      }
      box.setAttribute('aria-controls', 'city-menu')
      box.setAttribute('aria-expanded', 'true')
      box.parentElement!.appendChild(lb)
    }, 30)
  })
  const fid = enumerateFields({ root: document, epoch: 9, measure: allVisible }).fields.find((f) => f.idAttr === 'city')!.fid
  return { box, typed, fid }
}

const fillCity = (fid: number, city: string, parts?: CityParts) =>
  fillFields(document, [{ handle: { frameId: 0, fid, epoch: 9 }, value: city, ...(parts === undefined ? {} : { city: parts }) }])

const SAME_NAME = ['Cambridge, Massachusetts, United States', 'Cambridge, United Kingdom', 'Cambridge, Ontario, Canada']

describe('a city typeahead is given the city alone and picks the result with the city and the country', () => {
  it('with a city of Cambridge and a country of United Kingdom, "Cambridge, United Kingdom" is committed among three Cambridges', async () => {
    const { box, typed, fid } = mountCityTypeahead(SAME_NAME)
    const report = await fillCity(fid, 'Cambridge', UK)
    expect(report.failed).toEqual([])
    expect(report.filled).toEqual([expect.objectContaining({ committed: 'Cambridge, United Kingdom' })])
    expect(box.value).toBe('Cambridge, United Kingdom')
    expect(typed).toEqual(['Cambridge'])
  })

  it('the same results with a country of United States commit the Massachusetts one', async () => {
    const { box, fid } = mountCityTypeahead(SAME_NAME)
    const report = await fillCity(fid, 'Cambridge', US)
    expect(report.filled).toEqual([expect.objectContaining({ committed: 'Cambridge, Massachusetts, United States' })])
    expect(box.value).toBe('Cambridge, Massachusetts, United States')
  })

  it('a result that writes the country in Portuguese matches the same way', async () => {
    const { box, fid } = mountCityTypeahead(['Cambridge, Massachusetts, Estados Unidos', 'Cambridge, Reino Unido'])
    const report = await fillCity(fid, 'Cambridge', UK)
    expect(report.filled).toHaveLength(1)
    expect(box.value).toBe('Cambridge, Reino Unido')
  })

  it('a result that writes the country by a short form matches the same way', async () => {
    const { box, fid } = mountCityTypeahead(['Cambridge, MA, USA', 'Cambridge, UK'])
    const report = await fillCity(fid, 'Cambridge', UK)
    expect(report.filled).toHaveLength(1)
    expect(box.value).toBe('Cambridge, UK')
  })

  it('two results with the city and the country are a miss: nothing committed, the typed text cleared, the results returned', async () => {
    const { box, fid } = mountCityTypeahead(['Cambridge, Cambridgeshire, United Kingdom', 'Cambridge, United Kingdom', 'Cambridge, Massachusetts, United States'])
    const report = await fillCity(fid, 'Cambridge', UK)
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([expect.objectContaining({
      reason: 'no-matching-option',
      options: ['Cambridge, Cambridgeshire, United Kingdom', 'Cambridge, United Kingdom', 'Cambridge, Massachusetts, United States'],
    })])
    expect(box.value).toBe('')
  })

  it('a lone match is not taken until a second poll finds the same results: a rival that mounts before the next poll makes it a miss', async () => {
    // The Massachusetts result is seen alone by the first poll only; Ohio
    // mounts before the next one.
    const { box, fid } = mountCityTypeahead(['Cambridge, Massachusetts, United States'], 'Cambridge, Ohio, United States')
    const report = await fillCity(fid, 'Cambridge', US)
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([expect.objectContaining({ reason: 'no-matching-option' })])
    expect(box.value).toBe('')
  })

  it('no result with the city and the country is a miss, even when only one result comes back: the typed text is cleared', async () => {
    const { box, typed, fid } = mountCityTypeahead(['Cambridge, Massachusetts, United States'])
    const report = await fillCity(fid, 'Cambridge', UK)
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([expect.objectContaining({ reason: 'no-matching-option', options: ['Cambridge, Massachusetts, United States'] })])
    expect(typed).toEqual(['Cambridge'])
    expect(box.value).toBe('')
  })

  it('with no country stored, the result equal to the city alone is committed', async () => {
    const { box, fid } = mountCityTypeahead(['Cambridge, Massachusetts, United States', 'Cambridge'])
    const report = await fillCity(fid, 'Cambridge', NO_COUNTRY)
    expect(report.filled).toHaveLength(1)
    expect(box.value).toBe('Cambridge')
  })

  it('with no country stored, a single result that names more than the city is a miss', async () => {
    const { box, fid } = mountCityTypeahead(['Cambridge, Massachusetts, United States'])
    const report = await fillCity(fid, 'Cambridge', NO_COUNTRY)
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([expect.objectContaining({ reason: 'no-matching-option' })])
    expect(box.value).toBe('')
  })
})

describe('the choice among the results', () => {
  it('a country name counts only as whole words: "US" is not inside "Massachusetts", "UK" not inside "Ukraine"', () => {
    expect(pickCityOption(['Cambridge, Massachusetts'], 'Cambridge', US)).toEqual({ found: 'none' })
    expect(pickCityOption(['Cambridge, Ukraine'], 'Cambridge', UK)).toEqual({ found: 'none' })
  })

  it('the city counts only as whole words: "Cambridgeshire" is not Cambridge', () => {
    expect(pickCityOption(['Cambridgeshire, United Kingdom'], 'Cambridge', UK)).toEqual({ found: 'none' })
  })

  it('case and spacing are ignored, and a hyphenated name matches', () => {
    expect(pickCityOption(['cambridge,  GRÃ-BRETANHA'], 'Cambridge', UK)).toEqual({ found: 'one', index: 0 })
  })

  it('an empty city picks nothing', () => {
    expect(pickCityOption(['Cambridge, United Kingdom'], '', UK)).toEqual({ found: 'none' })
  })
})

// PR #36 manual pass 2: eight results shared the stored city's name, five of
// them in the stored country; only the stored region told them apart, and
// "<city> do Norte" is another city.
describe('the stored region decides among results that name the city and the country', () => {
  const SPRINGFIELDS = ['Springfield, Illinois, United States', 'Springfield, Missouri, United States', 'Springfield, Massachusetts, United States']
  const ILLINOIS: CityParts = { ...US, region: 'Illinois' }

  it('three results with the city and the country: the one with the region is picked', () => {
    expect(pickCityOption(SPRINGFIELDS, 'Springfield', ILLINOIS)).toEqual({ found: 'one', index: 0 })
  })

  it('with no region stored they stay a miss, and so with a region none of them names', () => {
    expect(pickCityOption(SPRINGFIELDS, 'Springfield', US)).toEqual({ found: 'many' })
    expect(pickCityOption(SPRINGFIELDS, 'Springfield', { ...US, region: 'Ohio' })).toEqual({ found: 'many' })
  })

  it('the city is the result\'s leading part: "Springfield Gardens" is another city', () => {
    expect(pickCityOption(['Springfield Gardens, New York, United States'], 'Springfield', US)).toEqual({ found: 'none' })
  })

  it('a region matches by its words, whatever the case', () => {
    expect(pickCityOption(['Newport, Isle Of Wight, United Kingdom', 'Newport, Wales, United Kingdom'], 'Newport', { ...UK, region: 'Isle of Wight' }))
      .toEqual({ found: 'one', index: 0 })
  })

  it('accents are ignored in the city, the region and the country', () => {
    expect(pickCityOption(['Montreal, Quebec, Canada', 'Montreal, Wisconsin, United States'], 'Montréal', { countryNames: ['Canada', 'Canadá'], region: 'Québec' }))
      .toEqual({ found: 'one', index: 0 })
  })

  it('on the page, the Illinois result is committed and only the city is typed', async () => {
    const { box, typed, fid } = mountCityTypeahead(SPRINGFIELDS)
    const report = await fillCity(fid, 'Springfield', ILLINOIS)
    expect(report.failed).toEqual([])
    expect(box.value).toBe('Springfield, Illinois, United States')
    expect(typed).toEqual(['Springfield'])
  }, 10_000)
})

