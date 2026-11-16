import { beforeEach, describe, expect, it } from 'vitest'
import { enumerateFields, type MeasureFn } from './enumerate'
import { REAL_FIXTURES, loadRealFixture } from './fixtures/real'

// These tests read the markup itself, not what Enumeration makes of it: each one
// proves that a fixture shows what the live review found on the real page.

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })

const PROTECTED = /gender|race|ethnicity|hispanic|latino|veteran|disabilit|sexual orientation|transgender|neurodiver/i
const TIES = 'fieldset, section, [role="group"]'
const CONTROL = 'input:not([type="hidden"]):not([type="submit"]), select, textarea'

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function byId(id: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[id]')).find((el) => el.id === id) ?? null
}

/** A Control's own label: `for`, a wrapping label, aria-labelledby, aria-label. */
function labelOf(control: Element): string {
  const id = control.getAttribute('id')
  if (id) {
    const label = Array.from(document.querySelectorAll('label[for]')).find((l) => l.getAttribute('for') === id)
    if (label) return text(label)
  }
  const wrapping = control.closest('label')
  if (wrapping) return text(wrapping)
  const labelledBy = control.getAttribute('aria-labelledby')
  if (labelledBy) return labelledBy.split(/\s+/).map((ref) => text(byId(ref))).join(' ').trim()
  return control.getAttribute('aria-label') ?? ''
}

/** The question a checkbox sits under: its group's legend or label. */
function questionOf(box: Element): { container: Element | null; text: string } {
  const container = box.closest('fieldset, [role="group"], li.application-question')
  if (!container) return { container: null, text: '' }
  const heading = container.querySelector('legend, .application-label')
  if (heading) return { container, text: text(heading) }
  const ref = container.getAttribute('aria-labelledby')
  return { container, text: ref ? text(byId(ref)) : '' }
}

function checkboxGroups(): HTMLInputElement[][] {
  const groups = new Map<string, HTMLInputElement[]>()
  for (const box of Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
    if (!box.name) continue
    groups.set(box.name, [...(groups.get(box.name) ?? []), box])
  }
  return [...groups.values()]
}

/** Boxes that share one name and one question container. */
function groupsUnderOneQuestion(min: number): { boxes: HTMLInputElement[]; question: string }[] {
  return checkboxGroups()
    .filter((boxes) => boxes.length >= min)
    .map((boxes) => ({ boxes, q: boxes.map(questionOf) }))
    .filter(({ q }) => q[0].container !== null && q.every((each) => each.container === q[0].container))
    .map(({ boxes, q }) => ({ boxes, question: q[0].text }))
}

function follows(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function headingLevel(el: Element): number {
  return Number(el.tagName.slice(1))
}

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('loadRealFixture', () => {
  it('holds the nine real-page fixtures', () => {
    expect([...REAL_FIXTURES].sort()).toEqual([
      'based-in-yes-no', 'greenhouse-accommodation', 'greenhouse-hosted-a', 'greenhouse-hosted-b',
      'greenhouse-hosted-resume-attached', 'greenhouse-self-id', 'lever-marketing-consent',
      'lever-pronoun-group', 'lever-source-group',
    ])
  })

  it.each(REAL_FIXTURES)('loads %s by name, and Enumeration finds a Field in it', (name) => {
    loadRealFixture(name)
    expect(document.querySelector(CONTROL)).not.toBeNull()
    const { fields } = enumerateFields({ root: document, epoch: 1, measure: allVisible })
    expect(fields.length).toBeGreaterThan(0)
  })

  it('takes the file name too, and refuses a name it does not hold', () => {
    loadRealFixture('lever-source-group.html')
    expect(document.querySelector('form')).not.toBeNull()
    expect(() => loadRealFixture('no-such-page')).toThrow(/no-such-page/)
  })

  it('names the Company "Acme" in the title', () => {
    for (const name of REAL_FIXTURES) {
      loadRealFixture(name)
      expect(document.title).toContain('Acme')
    }
  })
})

describe('each real-page fixture shows its review finding', () => {
  it('lever-source-group: a "how did you hear" checkbox group with a LinkedIn Option', () => {
    loadRealFixture('lever-source-group')
    const group = groupsUnderOneQuestion(2).find(({ boxes }) => boxes.some((box) => labelOf(box) === 'LinkedIn'))
    expect(group).toBeDefined()
    expect(group?.question).toMatch(/hear about us/i)
  })

  it('lever-marketing-consent: a lone checkbox that mentions email', () => {
    loadRealFixture('lever-marketing-consent')
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    const lone = boxes.filter((box) => {
      const label = box.closest('label')
      const sameName = boxes.filter((other) => other.name === box.name)
      return box.name !== '' && sameName.length === 1 && label !== null && label.querySelectorAll('input[type="checkbox"]').length === 1
    })
    expect(lone.some((box) => /e-?mail/i.test(labelOf(box)))).toBe(true)
  })

  it('based-in-yes-no: a yes/no question about where the applicant is based', () => {
    loadRealFixture('based-in-yes-no')
    const label = Array.from(document.querySelectorAll('label')).find((l) => /based in/i.test(text(l)))
    expect(label).toBeDefined()
    const entry = label?.parentElement
    const buttons = Array.from(entry?.querySelectorAll('button') ?? []).map(text)
    expect(buttons).toEqual(expect.arrayContaining(['Yes', 'No']))
    const target = label?.getAttribute('for') ?? ''
    expect(entry?.querySelector(`[name="${target}"], [id="${target}"]`)).not.toBeNull()
  })

  it('lever-pronoun-group: a pronoun question asked as a checkbox group', () => {
    loadRealFixture('lever-pronoun-group')
    const group = groupsUnderOneQuestion(3).find(({ question }) => /pronoun/i.test(question))
    expect(group).toBeDefined()
  })

  it('greenhouse-self-id: protected-attribute Fields under a heading nothing ties to them, a lone required checkbox, identity Fields outside', () => {
    loadRealFixture('greenhouse-self-id')
    const controls = Array.from(document.querySelectorAll(CONTROL))
    const demographic = controls.filter((c) => PROTECTED.test(labelOf(c)))
    expect(demographic.length).toBeGreaterThan(0)

    const headings = Array.from(document.querySelectorAll('form h1, form h2, form h3, form h4, form h5, form h6'))
    const heading = headings.find((h) => /demographic|self-identification|voluntary/i.test(text(h)))
    expect(heading).toBeDefined()
    if (!heading) return
    const next = headings.find((h) => follows(heading, h) && headingLevel(h) <= headingLevel(heading))
    const inSection = (el: Element) => follows(heading, el) && (next === undefined || follows(el, next))

    const sectionFields = demographic.filter(inSection)
    expect(sectionFields.length).toBeGreaterThan(0)
    for (const field of sectionFields) {
      for (let el: Element | null = field; el !== null && !el.contains(heading); el = el.parentElement) {
        expect(el.matches(TIES)).toBe(false)
      }
      let common: Element | null = field
      while (common !== null && !common.contains(heading)) common = common.parentElement
      expect(common?.matches(TIES)).toBe(false)
    }

    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    const loneRequired = boxes.filter((box) =>
      inSection(box) &&
      (box.required || box.getAttribute('aria-required') === 'true') &&
      boxes.filter((other) => other.name === box.name).length === 1)
    expect(loneRequired).toHaveLength(1)

    const outside = controls.filter((c) => !inSection(c))
    expect(outside.some((c) => /^(first )?name\b/i.test(labelOf(c)))).toBe(true)
    expect(outside.some((c) => /^e-?mail\b/i.test(labelOf(c)))).toBe(true)
  })

  it('greenhouse-self-id and greenhouse-accommodation: a flag dropdown inside the phone box\'s wrapper, its list mounted and hidden by a class', () => {
    for (const name of ['greenhouse-self-id', 'greenhouse-accommodation']) {
      loadRealFixture(name)
      const phone = document.querySelector('input[type="tel"]')!
      const wrapper = phone.parentElement!
      expect(wrapper.querySelector('label')).toBeNull()
      const button = wrapper.querySelector('button[aria-haspopup]')!
      const list = document.getElementById(button.getAttribute('aria-controls')!)!
      expect(list.classList.contains('iti__hide')).toBe(true)
      const options = Array.from(list.querySelectorAll('[role="option"]')).map(text)
      expect(options).toEqual(expect.arrayContaining(['United States+1', 'Canada+1']))
    }
  })

  it('greenhouse-hosted-a and greenhouse-hosted-b: a Country dropdown paired with the phone box in one fieldset', () => {
    for (const name of ['greenhouse-hosted-a', 'greenhouse-hosted-b']) {
      loadRealFixture(name)
      const phone = document.querySelector('input[type="tel"]')!
      const group = phone.closest('fieldset')!
      expect(text(group.querySelector('legend'))).toBe('Phone')
      const reachable = Array.from(group.querySelectorAll(CONTROL)).filter((c) => c !== phone && c.getAttribute('aria-hidden') !== 'true')
      expect(reachable.map((c) => [c.getAttribute('role'), labelOf(c)])).toEqual([['combobox', 'Country*']])
    }
  })

  it('greenhouse-hosted-resume-attached: the resume group shows the file name and no file input; the cover letter group keeps its input', () => {
    loadRealFixture('greenhouse-hosted-resume-attached')
    const resume = document.querySelector('[role="group"][aria-labelledby="upload-label-resume"]')!
    expect(text(byId('upload-label-resume'))).toBe('Resume/CV*')
    expect(resume.querySelector('input[type="file"]')).toBeNull()
    expect(text(resume.querySelector('.file-upload__filename'))).toBe('ada-lovelace-resume.pdf')
    expect(document.getElementById('resume')).toBeNull()
    const cover = document.querySelector('[role="group"][aria-labelledby="upload-label-cover_letter"]')!
    expect(text(byId('upload-label-cover_letter'))).toBe('Cover Letter')
    expect(cover.querySelector('input[type="file"]')?.id).toBe('cover_letter')
    expect(cover.querySelector('.file-upload__filename')).toBeNull()
  })

  it('greenhouse-accommodation: a Control whose label asks about accommodation', () => {
    loadRealFixture('greenhouse-accommodation')
    const controls = Array.from(document.querySelectorAll(CONTROL))
    expect(controls.some((c) => /accommodat/i.test(labelOf(c)))).toBe(true)
  })
})
