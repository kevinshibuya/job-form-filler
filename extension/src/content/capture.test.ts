import { beforeEach, describe, expect, it } from 'vitest'
import { CAPTURE_CUT_MARK, CAPTURE_MAX_CHARS } from '@jff/shared'
import { capturePage } from './capture'
import { enumerateFields, type MeasureFn } from './enumerate'

// A Capture's page (spec #41, ticket #47). The page script cleans a copy of its
// document and hands back only that. These tests run it over a form the
// applicant has filled: a typed name, a ticked box, a chosen native Option and
// a committed dropdown choice, which the page shows as ordinary text beside an
// emptied search box. What they assert is what the cleaned page holds.

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })

const PAGE = `<head><title>Apply</title><script>window.cfg = { token: 'abc' }</script></head><body>
  <main>
    <form id="apply" action="https://acme.example.org/apply?ref=board">
      <div class="field"><label for="name">Full name</label><input id="name" name="name" type="text"></div>
      <div class="field"><label><input id="agree" type="checkbox" name="agree" value="yes">I agree to the terms</label></div>
      <div class="field">
        <label for="country">Country</label>
        <select id="country" name="country"><option value="">Select…</option><option value="br">Brazil</option><option value="ca">Canada</option></select>
      </div>
      <div class="field" id="location-field">
        <label id="location-label">Location</label>
        <div class="select__control">
          <div class="select__value-container">
            <div class="select__single-value" id="committed">Lisbon</div>
            <div class="select__input-container" data-value=""><input id="location" role="combobox" aria-expanded="false" aria-labelledby="location-label" value=""></div>
          </div>
        </div>
        <input type="hidden" name="location" value="31">
      </div>
      <fieldset id="office">
        <legend>Preferred office</legend>
        <label><input type="radio" name="office" value="lisbon">Lisbon</label>
        <label><input type="radio" name="office" value="london">London</label>
      </fieldset>
    </form>
  </main>
</body>`

/** The page as the applicant left it, Scanned so its Controls carry their fids. */
function loadFilledPage(): number {
  document.documentElement.innerHTML = PAGE
  ;(document.getElementById('name') as HTMLInputElement).value = 'Ada Lovelace'
  ;(document.getElementById('agree') as HTMLInputElement).checked = true
  ;(document.getElementById('country') as HTMLSelectElement).value = 'ca'
  const { fields } = enumerateFields({ root: document, epoch: 1, measure: allVisible })
  const location = fields.find((f) => f.idAttr === 'location')
  if (location === undefined) throw new Error('the Scan found no location Field')
  return location.fid
}

/** The cleaned page, parsed back so a test can read it as a page. */
function parsed(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

let locationFid = -1
beforeEach(() => { locationFid = loadFilledPage() })

/** What the Side panel knows: the dropdown's committed Value. */
const held = (): { fid: number; value: string }[] => [{ fid: locationFid, value: 'Lisbon' }]

describe('the cleaned page of a filled form', () => {
  it('holds no typed name, no ticked box, no chosen native Option and no committed dropdown choice', () => {
    const { html } = capturePage(document, held())
    const page = parsed(html)
    expect(html).not.toContain('Ada Lovelace')
    expect(page.querySelector('#agree')?.hasAttribute('checked')).toBe(false)
    expect([...page.querySelectorAll('#country option')].filter((o) => o.hasAttribute('selected'))).toEqual([])
    expect(page.getElementById('committed')?.textContent).toBe('')
  })

  it('still holds every question label and every Option label that is not a held Value', () => {
    const page = parsed(capturePage(document, held()).html)
    const text = page.body.textContent ?? ''
    for (const label of ['Full name', 'I agree to the terms', 'Country', 'Location', 'Preferred office']) expect(text).toContain(label)
    expect([...page.querySelectorAll('#country option')].map((o) => o.textContent)).toEqual(['Select…', 'Brazil', 'Canada'])
    // The radio's Option "Lisbon" sits outside the dropdown's widget, so it is kept.
    expect([...page.querySelectorAll('#office label')].map((l) => l.textContent?.trim())).toEqual(['Lisbon', 'London'])
  })

  it('blanks a dropdown\'s committed choice only inside that dropdown\'s widget', () => {
    const page = parsed(capturePage(document, held()).html)
    expect(page.getElementById('location-field')?.textContent).not.toContain('Lisbon')
    expect(page.getElementById('office')?.textContent).toContain('Lisbon')
  })

  it('is the shared privacy step\'s output: no script, and no address', () => {
    const { html } = capturePage(document, held())
    const page = parsed(html)
    expect(page.querySelector('script')).toBeNull()
    expect(html).not.toContain('token')
    expect(html).not.toContain('acme.example.org')
    expect(page.querySelector('input[name="location"]')?.getAttribute('value') ?? '').toBe('')
  })

  it('blanks the text a dropdown shows as its own Value without the Side panel\'s help', () => {
    document.getElementById('location-field')!.innerHTML =
      '<label id="lbl">Location</label><div role="combobox" id="shown" aria-labelledby="lbl">Lisbon</div>'
    enumerateFields({ root: document, epoch: 2, measure: allVisible })
    const page = parsed(capturePage(document, []).html)
    expect(page.getElementById('shown')?.textContent).toBe('')
    expect(page.getElementById('office')?.textContent).toContain('Lisbon')
  })
})

describe('the page the content script was asked to capture', () => {
  it('is unchanged afterwards: its Values are still on the page', () => {
    const before = document.documentElement.outerHTML
    capturePage(document, held())
    expect(document.documentElement.outerHTML).toBe(before)
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('Ada Lovelace')
    expect((document.getElementById('agree') as HTMLInputElement).checked).toBe(true)
    expect((document.getElementById('country') as HTMLSelectElement).value).toBe('ca')
    expect(document.getElementById('committed')?.textContent).toBe('Lisbon')
    expect(document.querySelector('script')).not.toBeNull()
  })
})

describe('a page longer than 2,000,000 characters', () => {
  it('is cut and carries the cut mark', () => {
    const long = document.createElement('p')
    long.textContent = 'x'.repeat(CAPTURE_MAX_CHARS + 10)
    document.body.append(long)
    const { html, cut } = capturePage(document, held())
    expect(cut).toBe(true)
    expect(html.length).toBeLessThanOrEqual(CAPTURE_MAX_CHARS)
    expect(html.endsWith(CAPTURE_CUT_MARK)).toBe(true)
  })

  it('is not cut when it fits', () => {
    const { html, cut } = capturePage(document, held())
    expect(cut).toBe(false)
    expect(html).not.toContain(CAPTURE_CUT_MARK)
  })
})
