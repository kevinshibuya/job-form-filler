import { describe, it, expect, beforeEach } from 'vitest'
import { walkElements, countUnreachableWidgets, labelFor, groupLabelFor, optionLabelOf } from './dom'
import { ASHBY_COMBOBOX, ASHBY_YESNO_EN, SHARED_WRAPPER_FIRST_LAST } from './fixtures/ashby'

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
