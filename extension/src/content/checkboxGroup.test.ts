import { describe, it, expect, beforeEach } from 'vitest'
import type { EnumField } from '@jff/shared'
import { elementByFid, enumerateFields, type MeasureFn } from './enumerate'
import { fillFields } from './fill'
import { snapshotValues } from './snapshot'
import { isDemographic } from './classify'
import { loadRealFixture } from './fixtures/real'

// The content script over real-page fixtures and small pages: which Fields a
// checkbox group yields, and what a Fill leaves on the page.

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })

const PRONOUNS = ['He/him', 'She/her', 'They/them', 'Xe/xem', 'Ze/hir', 'Ey/em', 'Hir/hir', 'Fae/faer', 'Hu/hu', 'Use name only', 'Custom']

function scanPage(): EnumField[] {
  return enumerateFields({
    root: document, epoch: 1, measure: allVisible,
    isDemographic: (el) => isDemographic(el, { isSubframe: false }),
  }).fields
}

function scanFixture(name: string): EnumField[] {
  loadRealFixture(name)
  return scanPage()
}

function scanHtml(html: string): EnumField[] {
  document.body.innerHTML = html
  return scanPage()
}

function only(fields: EnumField[], label: RegExp): EnumField {
  const hits = fields.filter((f) => label.test(f.label ?? ''))
  if (hits.length !== 1) throw new Error(`${hits.length} Fields labelled ${label}; there are: ${fields.map((f) => `${f.kind}:${(f.label ?? '').slice(0, 40)}`).join(' | ')}`)
  return hits[0]!
}

function boxLabelled(text: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent ?? '').trim() === text)
  const box = label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null
  if (box === null) throw new Error(`no box labelled ${text}`)
  return box
}

function ticked(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter((b) => b.checked)
    .map((b) => (b.closest('label')?.textContent ?? '').trim())
}

const handle = (f: EnumField) => ({ frameId: 0, fid: f.fid, epoch: f.epoch })
const fill = (f: EnumField, value: string) => fillFields(document, [{ handle: handle(f), value }])

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('Enumeration reports a checkbox group as one Field', () => {
  it('the pronoun question is one Field, labelled with the question, with every box as an Option', () => {
    const fields = scanFixture('lever-pronoun-group')
    const pronouns = only(fields, /^pronouns$/i)
    expect(pronouns.kind).toBe('checkboxgroup')
    expect(pronouns.options).toEqual(PRONOUNS)
    for (const option of PRONOUNS) {
      expect(fields.filter((f) => f.label === option)).toEqual([])
    }
  })

  it('the "how did you hear about us" question is one Field, and LinkedIn is one of its Options, not a Field', () => {
    const fields = scanFixture('lever-source-group')
    const source = only(fields, /how did you hear about us/i)
    expect(source.kind).toBe('checkboxgroup')
    expect(source.options).toContain('LinkedIn')
    expect(fields.filter((f) => f.label === 'LinkedIn')).toEqual([])
  })

  it('boxes under one group label with different names are one Field', () => {
    const fields = scanHtml(`
      <fieldset><legend>Which languages do you speak?</legend>
        <label><input type="checkbox" name="lang_en"> English</label>
        <label><input type="checkbox" name="lang_pt"> Portuguese</label>
        <label><input type="checkbox" name="lang_es"> Spanish</label>
      </fieldset>`)
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({
      kind: 'checkboxgroup', label: 'Which languages do you speak?', options: ['English', 'Portuguese', 'Spanish'],
    })
  })

  it('boxes that share a name with no group label are one Field', () => {
    const fields = scanHtml(`
      <form>
        <label><input type="checkbox" name="shift" value="am"> Mornings</label>
        <label><input type="checkbox" name="shift" value="pm"> Evenings</label>
      </form>`)
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ kind: 'checkboxgroup', options: ['Mornings', 'Evenings'] })
  })

  it('a lone checkbox is still its own Field of the checkbox kind', () => {
    const fields = scanFixture('lever-pronoun-group')
    const consent = only(fields, /consent to contact me/i)
    expect(consent.kind).toBe('checkbox')
    expect(consent.options).toEqual([])
  })

  it('two consent boxes under one heading stay two lone checkboxes', () => {
    const fields = scanHtml(`
      <form><h3>Agreements</h3>
        <label><input type="checkbox" name="terms"> I accept the terms</label>
        <label><input type="checkbox" name="privacy"> I accept the privacy policy</label>
      </form>`)
    expect(fields.map((f) => [f.kind, f.label])).toEqual([
      ['checkbox', 'I accept the terms'], ['checkbox', 'I accept the privacy policy'],
    ])
  })

  it('two nameless consent boxes under one heading stay two lone checkboxes', () => {
    const fields = scanHtml(`
      <form><h3>Agreements</h3>
        <label><input type="checkbox"> I accept the terms</label>
        <label><input type="checkbox"> I accept the privacy policy</label>
      </form>`)
    expect(fields.map((f) => f.kind)).toEqual(['checkbox', 'checkbox'])
  })

  it('a group is required when any one box is required', () => {
    const fields = scanHtml(`
      <fieldset><legend>Shifts</legend>
        <label><input type="checkbox" name="shift"> Mornings</label>
        <label><input type="checkbox" name="shift" required> Evenings</label>
      </fieldset>`)
    expect(fields[0]).toMatchObject({ kind: 'checkboxgroup', required: true })
  })

  it('a group is required when its question carries the required mark, and not otherwise', () => {
    const required = scanHtml(`
      <ul><li><div class="application-label"><div class="text">Shifts<span class="required">✱</span></div></div>
        <div class="application-field"><ul>
          <li><label><input type="checkbox" name="shift"> Mornings</label></li>
          <li><label><input type="checkbox" name="shift"> Evenings</label></li>
        </ul></div></li></ul>`)
    expect(required[0]).toMatchObject({ kind: 'checkboxgroup', label: 'Shifts', required: true })

    const optional = scanHtml(`
      <fieldset><legend>Shifts</legend>
        <label><input type="checkbox" name="shift"> Mornings</label>
        <label><input type="checkbox" name="shift"> Evenings</label>
      </fieldset>`)
    expect(optional[0]).toMatchObject({ kind: 'checkboxgroup', required: false })
  })

  it('the source question, whose boxes are required, is a required Field', () => {
    expect(only(scanFixture('lever-source-group'), /how did you hear about us/i).required).toBe(true)
  })

  it('a checkbox group under a demographic heading is one demographic Field', () => {
    const fields = scanHtml(`
      <form>
        <section class="eeo-section"><h4>Voluntary self-identification</h4>
          <div><div>Which of these describe you?</div>
            <ul>
              <li><label><input type="checkbox" name="eeo_q"> Option A</label></li>
              <li><label><input type="checkbox" name="eeo_q"> Option B</label></li>
              <li><label><input type="checkbox" name="eeo_q"> Prefer not to say</label></li>
            </ul></div>
        </section>
      </form>`)
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ kind: 'checkboxgroup', label: 'Which of these describe you?', demographic: true })
  })

  it('a group the page hides behind styled boxes is one Field, not visible, keeping its label', () => {
    document.body.innerHTML = `
      <fieldset><legend>Shifts</legend>
        <label><input type="checkbox" name="shift"><span>Mornings</span></label>
        <label><input type="checkbox" name="shift"><span>Evenings</span></label>
      </fieldset>`
    const hiddenBoxes: MeasureFn = (el) => ({ ...allVisible(el), clipped: el instanceof HTMLInputElement })
    const { fields } = enumerateFields({ root: document, epoch: 1, measure: hiddenBoxes })
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ kind: 'checkboxgroup', label: 'Shifts', visible: false })
  })
})

describe('a Fill of a checkbox group leaves exactly the chosen Options ticked', () => {
  it('two chosen Options end ticked, a box ticked before and not chosen is cleared, and the Field is reported filled', async () => {
    const pronouns = only(scanFixture('lever-pronoun-group'), /^pronouns$/i)
    boxLabelled('Use name only').checked = true
    const report = await fill(pronouns, 'She/her\nThey/them')
    expect(report.failed).toEqual([])
    expect(report.filled).toEqual([{ handle: handle(pronouns), committed: null }])
    expect(ticked()).toEqual(['She/her', 'They/them'])
  })

  it('a chosen label that differs from a box label only in case or spacing ticks that box', async () => {
    const pronouns = only(scanFixture('lever-pronoun-group'), /^pronouns$/i)
    const report = await fill(pronouns, '  she/HER \nuse  name only')
    expect(report.filled.map((f) => f.handle)).toEqual([handle(pronouns)])
    expect(ticked()).toEqual(['She/her', 'Use name only'])
  })

  it('a label no box carries fails the Field, reports nothing filled and leaves the page as it was', async () => {
    const pronouns = only(scanFixture('lever-pronoun-group'), /^pronouns$/i)
    boxLabelled('He/him').checked = true
    const report = await fill(pronouns, 'She/her\nThey/themselves')
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([{ handle: handle(pronouns), reason: 'no-matching-option' }])
    expect(ticked()).toEqual(['He/him'])
  })

  it('a page that rejects the click is reported failed, not filled', async () => {
    const source = only(scanFixture('lever-source-group'), /how did you hear about us/i)
    boxLabelled('LinkedIn').addEventListener('click', (e) => { e.preventDefault() })
    const report = await fill(source, 'LinkedIn\nEmployee Referral')
    expect(report.filled).toEqual([])
    expect(report.failed).toEqual([{ handle: handle(source), reason: 'click-rejected' }])
  })

  it('a box the page unticks right after the click is reported failed, not filled', async () => {
    const source = only(scanFixture('lever-source-group'), /how did you hear about us/i)
    const linkedin = boxLabelled('LinkedIn')
    linkedin.addEventListener('click', () => { setTimeout(() => { linkedin.checked = false }, 0) })
    const report = await fill(source, 'LinkedIn')
    expect(report.filled).toEqual([])
    expect(report.failed.map((f) => f.handle)).toEqual([handle(source)])
  })
})

describe('boxes ticked on the page are the group Value, as labels joined by a newline', () => {
  it('at Scan, the boxes already ticked are the Field\'s current Value, in page order', () => {
    loadRealFixture('lever-pronoun-group')
    boxLabelled('They/them').checked = true
    boxLabelled('He/him').checked = true
    const pronouns = only(scanPage(), /^pronouns$/i)
    expect(pronouns.currentValue).toBe('He/him\nThey/them')
  })

  it('when the page is read again, the group holds the ticked labels and never "true"', () => {
    const pronouns = only(scanFixture('lever-pronoun-group'), /^pronouns$/i)
    expect(snapshotValues(document)[pronouns.fid]).toBeUndefined()
    boxLabelled('Custom').checked = true
    boxLabelled('She/her').checked = true
    expect(snapshotValues(document)[pronouns.fid]).toBe('She/her\nCustom')
  })

  it('a box of a group clicked on the page reads as its label, not as a Field of its own', () => {
    const pronouns = only(scanFixture('lever-pronoun-group'), /^pronouns$/i)
    expect(elementByFid(document, pronouns.fid)).toBe(boxLabelled('He/him'))
    boxLabelled('Xe/xem').click()
    const values = snapshotValues(document)
    expect(values[pronouns.fid]).toBe('Xe/xem')
    expect(Object.values(values)).not.toContain('true')
  })
})
