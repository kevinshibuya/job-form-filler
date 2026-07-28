import { describe, it, expect, beforeEach } from 'vitest'
import { walkElements, countUnreachableWidgets, labelFor, groupLabelFor, optionLabelOf } from './dom'

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
    expect(labelFor(document.getElementById('x')!)).toBe('First Name')
  })

  it('falls back to aria-label', () => {
    document.body.innerHTML = '<input id="x" aria-label="Email">'
    expect(labelFor(document.getElementById('x')!)).toBe('Email')
  })

  it('falls back to aria-labelledby, joining referenced nodes', () => {
    document.body.innerHTML = '<span id="l1">Work</span><span id="l2">Authorization</span><input id="x" aria-labelledby="l1 l2">'
    expect(labelFor(document.getElementById('x')!)).toBe('Work Authorization')
  })

  it('falls back to a wrapping label, then a fieldset legend, then placeholder', () => {
    document.body.innerHTML = '<label>Wrapped<input id="a"></label>'
    expect(labelFor(document.getElementById('a')!)).toBe('Wrapped')
    document.body.innerHTML = '<fieldset><legend>Gender *</legend><input id="b"></fieldset>'
    expect(labelFor(document.getElementById('b')!)).toBe('Gender')
    document.body.innerHTML = '<input id="c" placeholder="Your phone">'
    expect(labelFor(document.getElementById('c')!)).toBe('Your phone')
  })

  it('resolves label[for] INSIDE the same shadow root, not the document', () => {
    const hostEl = document.createElement('my-widget')
    document.body.appendChild(hostEl)
    const shadow = hostEl.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<label for="s">Shadow Label</label><input id="s">'
    const input = shadow.getElementById('s')!
    expect(labelFor(input)).toBe('Shadow Label')
  })

  it('returns null when nothing labels the element', () => {
    document.body.innerHTML = '<input id="x">'
    expect(labelFor(document.getElementById('x')!)).toBeNull()
  })
})

describe('groupLabelFor', () => {
  it('uses the fieldset legend, NEVER the wrapping option label', () => {
    document.body.innerHTML = `<fieldset><legend>Work model *</legend>
      <label><input type="radio" name="wm" value="r" id="r1"> Remote</label></fieldset>`
    expect(groupLabelFor(document.getElementById('r1')!)).toBe('Work model')
  })

  it('falls back to a [role=group] aria-label', () => {
    document.body.innerHTML = `<div role="group" aria-label="Pronouns">
      <label><input type="radio" name="p" id="p1"> She/her</label></div>`
    expect(groupLabelFor(document.getElementById('p1')!)).toBe('Pronouns')
  })

  it('returns null when no group container labels the radios', () => {
    document.body.innerHTML = `<label><input type="radio" name="x" id="x1"> Yes</label>`
    expect(groupLabelFor(document.getElementById('x1')!)).toBeNull()
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
