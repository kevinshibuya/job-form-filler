import { describe, it, expect, beforeEach } from 'vitest'
import type { AtsModule } from '@jff/shared'
import { walkElements, countUnreachableWidgets, labelFor, groupLabelFor, optionLabelOf, requiredFromBinding, descriptionFor, DESCRIPTION_MAX_CHARS } from './dom'
import { ASHBY_COMBOBOX, ASHBY_YESNO_EN, SHARED_WRAPPER_FIRST_LAST, ASHBY_RADIO_FIELDSET, ASHBY_CONSENT_SINGLE, ASHBY_ESSAY_WITH_DESCRIPTION, ASHBY_COMBOBOX_WITH_DESCRIPTION, ASHBY_REQUIRED_BY_CLASS, ASHBY_OPTIONAL_FIELD, STAR_REQUIRED_FIELD } from './fixtures/ashby'

beforeEach(() => { document.body.innerHTML = '' })

describe('walkElements', () => {
  it('walks the light DOM', () => {
    document.body.innerHTML = '<div><input id="a"><span><select id="b"></select></span></div>'
    const ids = walkElements(document).map((e) => e.id).filter(Boolean)
    expect(ids).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('pierces OPEN shadow roots', () => {
    const hostEl = document.createElement('my-widget')
    document.body.appendChild(hostEl)
    const shadow = hostEl.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<input id="inside-shadow">'
    const ids = walkElements(document).map((e) => e.id)
    expect(ids).toContain('inside-shadow')
  })

  it('pierces nested open shadow roots', () => {
    const outer = document.createElement('outer-widget')
    document.body.appendChild(outer)
    const os = outer.attachShadow({ mode: 'open' })
    const inner = document.createElement('inner-widget')
    os.appendChild(inner)
    inner.attachShadow({ mode: 'open' }).innerHTML = '<input id="deep">'
    expect(walkElements(document).map((e) => e.id)).toContain('deep')
  })
})

describe('countUnreachableWidgets', () => {
  it('counts a custom element with a closed shadow root as unreachable', () => {
    const hostEl = document.createElement('closed-widget')
    document.body.appendChild(hostEl)
    hostEl.attachShadow({ mode: 'closed' })
    expect(countUnreachableWidgets(document)).toBe(1)
  })

  it('does not count a custom element with an open shadow root', () => {
    const hostEl = document.createElement('open-widget')
    document.body.appendChild(hostEl)
    hostEl.attachShadow({ mode: 'open' }).innerHTML = '<input>'
    expect(countUnreachableWidgets(document)).toBe(0)
  })

  it('does not count a plain custom element that renders light DOM', () => {
    document.body.innerHTML = '<my-field><input></my-field>'
    expect(countUnreachableWidgets(document)).toBe(0)
  })
})

describe('labelFor', () => {
  it('prefers an explicit label[for]', () => {
    document.body.innerHTML = '<label for="x">First Name *</label><input id="x" aria-label="ignored">'
    expect(labelFor(document.getElementById('x')!)).toMatchObject({ text: 'First Name', source: 'explicit' })
  })

  it('falls back to aria-label (no element in the binding)', () => {
    document.body.innerHTML = '<input id="x" aria-label="Email">'
    expect(labelFor(document.getElementById('x')!)).toMatchObject({ text: 'Email', source: 'aria-label', element: null })
  })

  it('falls back to aria-labelledby, joining referenced nodes', () => {
    document.body.innerHTML = '<span id="l1">Work</span><span id="l2">Authorization</span><input id="x" aria-labelledby="l1 l2">'
    expect(labelFor(document.getElementById('x')!)).toMatchObject({ text: 'Work Authorization', source: 'aria-labelledby' })
  })

  it('falls back to a wrapping label, then a fieldset legend', () => {
    document.body.innerHTML = '<label>Wrapped<input id="a"></label>'
    expect(labelFor(document.getElementById('a')!).text).toBe('Wrapped')
    document.body.innerHTML = '<fieldset><legend>Gender *</legend><input id="b"></fieldset>'
    expect(labelFor(document.getElementById('b')!)).toMatchObject({ text: 'Gender', source: 'legend' })
  })

  it('repairs an Ashby dangling label: combobox gets the question, NEVER the placeholder', () => {
    document.body.innerHTML = ASHBY_COMBOBOX
    const combo = document.querySelector('[role="combobox"]')!
    const b = labelFor(combo)
    expect(b.text).toBe('Select your country of employment')
    expect(b.source).toBe('dangling')
    expect(b.element).toBe(document.querySelector('label'))
  })

  it('binds a dangling label to a hidden yes/no checkbox (single control in wrapper)', () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    const cb = document.querySelector('input[type="checkbox"]')!
    expect(labelFor(cb).text).toBe('Are you legally authorized to work in your current country of employment?')
  })

  it('does NOT bind a dangling label when the wrapper holds two enumerable controls', () => {
    document.body.innerHTML = SHARED_WRAPPER_FIRST_LAST
    const [first, last] = Array.from(document.querySelectorAll('input'))
    expect(labelFor(first!)).toMatchObject({ text: 'First name', source: 'placeholder' })
    expect(labelFor(last!)).toMatchObject({ text: 'Last name', source: 'placeholder' })
  })

  it('matches a dangling label to the control whose NAME equals its for (name==for)', () => {
    document.body.innerHTML = `
      <div>
        <label for="u1">Question A</label>
        <input name="u1">
        <input name="u2" placeholder="Other">
      </div>`
    expect(labelFor(document.querySelector('input[name="u1"]')!)).toMatchObject({ text: 'Question A', source: 'name-for' })
    expect(labelFor(document.querySelector('input[name="u2"]')!)).toMatchObject({ text: 'Other', source: 'placeholder' })
  })

  it('climbs to an ancestor heading when the territory holds no other control', () => {
    document.body.innerHTML = '<div class="wrap"><h3>Years of experience</h3><div><input id="yy"></div></div>'
    expect(labelFor(document.getElementById('yy')!)).toMatchObject({ text: 'Years of experience', source: 'climb' })
  })

  it('never consults an ancestor that contains another enumerated control', () => {
    document.body.innerHTML = `
      <div><h3>Section title</h3>
        <div><input id="a1" placeholder="A"></div>
        <div><input id="a2" placeholder="B"></div>
      </div>`
    expect(labelFor(document.getElementById('a1')!)).toMatchObject({ text: 'A', source: 'placeholder' })
  })

  it('rejects a climbed label whose for resolves to a DIFFERENT control', () => {
    document.body.innerHTML = '<div><label for="other-ctl">Other question</label><input id="x2"></div><input id="other-ctl" aria-label="Other question">'
    expect(labelFor(document.getElementById('x2')!)).toMatchObject({ text: null, source: 'none' })
  })

  it('counts radios sharing a name as ONE control for the dangling rule', () => {
    document.body.innerHTML = `
      <div>
        <label for="ghost-uuid">Pick one</label>
        <input type="radio" name="g1"><input type="radio" name="g1"><input type="radio" name="g1">
      </div>`
    expect(labelFor(document.querySelector('input')!)).toMatchObject({ text: 'Pick one', source: 'dangling' })
  })

  it('uses placeholder only as the true last resort', () => {
    document.body.innerHTML = '<input id="c" placeholder="Your phone">'
    expect(labelFor(document.getElementById('c')!)).toMatchObject({ text: 'Your phone', source: 'placeholder' })
  })

  it('resolves label[for] INSIDE the same shadow root, not the document', () => {
    const hostEl = document.createElement('my-widget')
    document.body.appendChild(hostEl)
    const shadow = hostEl.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<label for="s">Shadow Label</label><input id="s">'
    expect(labelFor(shadow.getElementById('s')!).text).toBe('Shadow Label')
  })

  it('returns the none binding when nothing labels the element', () => {
    document.body.innerHTML = '<input id="x">'
    expect(labelFor(document.getElementById('x')!)).toEqual({ text: null, source: 'none', element: null })
  })
})

describe('groupLabelFor', () => {
  it('uses the fieldset legend, NEVER the wrapping option label', () => {
    document.body.innerHTML = `<fieldset><legend>Work model *</legend>
      <label><input type="radio" name="wm" value="r" id="r1"> Remote</label></fieldset>`
    expect(groupLabelFor(document.getElementById('r1')!).text).toBe('Work model')
  })

  it('falls back to a [role=group] aria-label', () => {
    document.body.innerHTML = `<div role="group" aria-label="Pronouns">
      <label><input type="radio" name="p" id="p1"> She/her</label></div>`
    expect(groupLabelFor(document.getElementById('p1')!).text).toBe('Pronouns')
  })

  it('returns null when no group container labels the radios', () => {
    document.body.innerHTML = `<label><input type="radio" name="x" id="x1"> Yes</label>`
    expect(groupLabelFor(document.getElementById('x1')!).text).toBeNull()
  })

  it('repairs the Ashby radio fieldset: group label is the question, never an option', () => {
    document.body.innerHTML = ASHBY_RADIO_FIELDSET
    const b = groupLabelFor(document.querySelector('input[type="radio"]')!)
    expect(b.text).toBe('Have you previously worked in a remote or hybrid environment?')
    expect(b.source).toBe('dangling')
    expect(b.text).not.toBe('Yes, fully remote')
  })

  it('binds the single-option consent group to the policy statement, not "I agree"', () => {
    document.body.innerHTML = ASHBY_CONSENT_SINGLE
    const b = groupLabelFor(document.querySelector('input[type="radio"]')!)
    expect(b.text).toMatch(/^By submitting your application/)
  })

  it('climbs for a group label under the same guards as labelFor', () => {
    document.body.innerHTML = `
      <div><h4>Preferred contact method</h4>
        <div>
          <label><input type="radio" name="cm" id="cm1"> Email</label>
          <label><input type="radio" name="cm"> Phone</label>
        </div>
      </div>`
    expect(groupLabelFor(document.getElementById('cm1')!)).toMatchObject({ text: 'Preferred contact method', source: 'climb' })
  })
})

describe('optionLabelOf', () => {
  it('uses the wrapping label text for a radio', () => {
    document.body.innerHTML = '<label><input type="radio" name="g" value="w"> Woman</label>'
    expect(optionLabelOf(document.querySelector('input')!)).toBe('Woman')
  })

  it('falls back to the value attribute', () => {
    document.body.innerHTML = '<input type="radio" name="g" value="Man">'
    expect(optionLabelOf(document.querySelector('input')!)).toBe('Man')
  })
})

describe('requiredFromBinding', () => {
  it('detects a literal * in the RAW label text (clean() strips it from .text)', () => {
    document.body.innerHTML = STAR_REQUIRED_FIELD
    const b = labelFor(document.getElementById('phone-input')!)
    expect(b.text).toBe('Phone') // the star never leaks into the label text
    expect(requiredFromBinding(b)).toBe(true)
  })

  it('detects a hashed CSS-module required class token', () => {
    document.body.innerHTML = ASHBY_REQUIRED_BY_CLASS
    const b = labelFor(document.querySelector('input')!)
    expect(requiredFromBinding(b)).toBe(true)
  })

  it('stays false for an optional Ashby field', () => {
    document.body.innerHTML = ASHBY_OPTIONAL_FIELD
    const b = labelFor(document.querySelector('input')!)
    expect(requiredFromBinding(b)).toBe(false)
  })

  it('does not trip on a not-required token', () => {
    document.body.innerHTML = '<label for="nr" class="field not-required">Nickname</label><input id="nr">'
    expect(requiredFromBinding(labelFor(document.getElementById('nr')!))).toBe(false)
  })

  it('is false for attribute-sourced bindings (no element)', () => {
    document.body.innerHTML = '<input id="al" aria-label="Email *">'
    expect(requiredFromBinding(labelFor(document.getElementById('al')!))).toBe(false)
  })
})

describe('descriptionFor', () => {
  it('captures a control-sibling description block, whitespace-normalized, markup discarded', () => {
    document.body.innerHTML = ASHBY_ESSAY_WITH_DESCRIPTION
    const el = document.querySelector('textarea')!
    const d = descriptionFor(el, labelFor(el))
    expect(d).toBe('Please include: • What made it challenging? • The total timeline from start to finish')
  })

  it("captures the control's-uncle description block and discards hrefs", () => {
    document.body.innerHTML = ASHBY_COMBOBOX_WITH_DESCRIPTION
    const el = document.querySelector('[role="combobox"]')!
    const d = descriptionFor(el, labelFor(el))
    expect(d).toBe('If unsure, choose the option that most closely matches your experience.')
    expect(d).not.toContain('http')
  })

  it('prefers aria-describedby targets over class-token blocks', () => {
    document.body.innerHTML = `
      <div>
        <label for="ad">Question</label>
        <span id="hint1">From aria.</span>
        <div class="description">From class.</div>
        <input id="ad" aria-describedby="hint1">
      </div>`
    const el = document.getElementById('ad')!
    expect(descriptionFor(el, labelFor(el))).toBe('From aria.')
  })

  it('never captures a block containing a form control', () => {
    document.body.innerHTML = `
      <div>
        <label for="fc">Question</label>
        <div class="help-row"><input type="checkbox" id="fc"> some layout text</div>
      </div>`
    const el = document.getElementById('fc')!
    expect(descriptionFor(el, labelFor(el))).toBeNull()
  })

  it('never captures an error/validation block', () => {
    document.body.innerHTML = `
      <div>
        <label for="ev">Question</label>
        <input id="ev">
        <div class="description validationError">This field is required</div>
      </div>`
    const el = document.getElementById('ev')!
    expect(descriptionFor(el, labelFor(el))).toBeNull()
  })

  it('caps at 500 chars', () => {
    const long = 'x'.repeat(700)
    document.body.innerHTML = `
      <div>
        <label for="lg">Question</label>
        <div class="description">${long}</div>
        <input id="lg">
      </div>`
    const el = document.getElementById('lg')!
    expect(descriptionFor(el, labelFor(el))!.length).toBe(DESCRIPTION_MAX_CHARS)
  })

  it('returns null when the binding has no element (no wrapper to search)', () => {
    document.body.innerHTML = '<div><div class="description">Nearby text</div><input id="nb" aria-label="Q"></div>'
    const el = document.getElementById('nb')!
    expect(descriptionFor(el, labelFor(el))).toBeNull()
  })
})

describe('an ATS module\'s label rule', () => {
  // A rule that answers for anything inside a `.question` block, from its `.q`.
  const mod: AtsModule = {
    id: 'lever',
    labelRule: (control) => {
      const block = control.closest('.question')?.querySelector('.q') ?? null
      return block === null ? null : { text: block.textContent ?? '', element: block }
    },
  }

  it('is tried first, before an explicit label, and records that the label came from the module', () => {
    document.body.innerHTML = '<div class="question"><div class="q">The question</div><label for="x">Polluted</label><input id="x"></div>'
    const control = document.getElementById('x')!
    expect(labelFor(control, mod)).toEqual({ text: 'The question', source: 'module', element: document.querySelector('.q') })
    expect(labelFor(control)).toMatchObject({ text: 'Polluted', source: 'explicit' })
  })

  it('answers for a radio group\'s question, while each Option keeps its own text', () => {
    document.body.innerHTML = `<div class="question"><div class="q">Work model</div><fieldset><legend>Polluted</legend>
      <label><input type="radio" name="wm" id="r1"> Remote</label></fieldset></div>`
    const radio = document.getElementById('r1')!
    expect(groupLabelFor(radio, mod)).toMatchObject({ text: 'Work model', source: 'module' })
    expect(optionLabelOf(radio)).toBe('Remote')
  })

  it('is never asked for a checkbox, which keeps its own text', () => {
    document.body.innerHTML = '<div class="question"><div class="q">Consent</div><label><input type="checkbox" id="c"> Email me</label></div>'
    expect(labelFor(document.getElementById('c')!, mod)).toMatchObject({ text: 'Email me', source: 'wrapping' })
  })

  it('lets the generic order run when it finds nothing', () => {
    document.body.innerHTML = '<label for="x">Email</label><input id="x">'
    expect(labelFor(document.getElementById('x')!, mod)).toMatchObject({ text: 'Email', source: 'explicit' })
  })

  it('changes nothing for a module with no rule', () => {
    document.body.innerHTML = '<div class="question"><div class="q">The question</div><input id="x" placeholder="Type your response"></div>'
    expect(labelFor(document.getElementById('x')!, { id: 'greenhouse' })).toMatchObject({ text: 'Type your response', source: 'placeholder' })
  })
})

describe('a label leaves out the text of the Controls inside it (#46)', () => {
  it('a dropdown inside its own label is labelled with its question and none of its Options', () => {
    document.body.innerHTML = '<label>Gender<select id="g"><option>Select ...</option><option>Male</option><option>Female</option></select></label>'
    expect(labelFor(document.getElementById('g')!)).toMatchObject({ text: 'Gender', source: 'wrapping' })
  })

  it('a label that holds a button keeps its own words and loses the button\'s', () => {
    document.body.innerHTML = '<label for="w">Website <button type="button">Clear</button></label><input id="w">'
    expect(labelFor(document.getElementById('w')!)).toMatchObject({ text: 'Website', source: 'explicit' })
  })

  it('a legend that holds a Control keeps only its own words', () => {
    document.body.innerHTML = '<fieldset><legend>Work model <button type="button">?</button></legend><input type="radio" name="m" id="r1"><input type="radio" name="m" id="r2"></fieldset>'
    expect(groupLabelFor(document.getElementById('r1')!)).toMatchObject({ text: 'Work model', source: 'group-legend' })
  })

  it('a text box with only a placeholder is still labelled with the placeholder', () => {
    document.body.innerHTML = '<div><input id="e" placeholder="Email address"></div>'
    expect(labelFor(document.getElementById('e')!)).toMatchObject({ text: 'Email address', source: 'placeholder' })
  })
})

describe('a file picker takes its group\'s label, never its button\'s words (#46)', () => {
  const upload = (key: string, title: string): string =>
    `<div role="group" aria-labelledby="upload-label-${key}"><div id="upload-label-${key}">${title}</div>`
    + `<button type="button">Attach</button><label for="${key}">Attach</label><input id="${key}" type="file"></div>`

  it('a file picker that is the only Control in a labelled group takes the group\'s label before its own', () => {
    document.body.innerHTML = upload('resume', 'Resume/CV<span class="required">*</span>') + upload('cover_letter', 'Cover Letter')
    expect(labelFor(document.getElementById('resume')!)).toMatchObject({ text: 'Resume/CV', source: 'group-aria' })
    expect(labelFor(document.getElementById('cover_letter')!)).toMatchObject({ text: 'Cover Letter', source: 'group-aria' })
  })

  it('a fieldset\'s legend counts as a group\'s label', () => {
    document.body.innerHTML = '<fieldset><legend>Portfolio</legend><label for="p">Upload a file</label><input id="p" type="file"></fieldset>'
    expect(labelFor(document.getElementById('p')!)).toMatchObject({ text: 'Portfolio', source: 'group-legend' })
  })

  it('a labelled group that holds two file pickers gives neither of them its label', () => {
    document.body.innerHTML = '<div role="group" aria-label="Documents">'
      + '<label for="a">Transcript</label><input id="a" type="file">'
      + '<label for="b">Certificate</label><input id="b" type="file"></div>'
    expect(labelFor(document.getElementById('a')!)).toMatchObject({ text: 'Transcript', source: 'explicit' })
    expect(labelFor(document.getElementById('b')!)).toMatchObject({ text: 'Certificate', source: 'explicit' })
  })

  it.each(['Attach', 'ATTACH', 'Upload a file.', 'Replace file', 'Uploading', 'Uploading...'])(
    'an upload wording ("%s") is passed over for the next source',
    (wording) => {
      document.body.innerHTML = `<label for="f">${wording}</label><input id="f" type="file" aria-label="Writing sample">`
      expect(labelFor(document.getElementById('f')!)).toMatchObject({ text: 'Writing sample', source: 'aria-label' })
    },
  )

  it('a file picker whose only label source is an upload wording has no label, and says so', () => {
    document.body.innerHTML = '<div><label for="f">Attach</label><input id="f" type="file"></div>'
    const binding = labelFor(document.getElementById('f')!)
    expect(binding).toMatchObject({ text: null, source: 'none', uploadWordingOnly: true })
  })

  it('a file picker with no label source at all does not say it lost an upload wording', () => {
    document.body.innerHTML = '<div><input id="f" type="file"></div>'
    expect(labelFor(document.getElementById('f')!).uploadWordingOnly).toBeUndefined()
  })

  it('a text box whose label is the word "Attach" keeps it: the wording rule is for file pickers only', () => {
    document.body.innerHTML = '<label for="t">Attach</label><input id="t">'
    expect(labelFor(document.getElementById('t')!)).toMatchObject({ text: 'Attach', source: 'explicit' })
  })
})
