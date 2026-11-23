import { beforeEach, describe, expect, it } from 'vitest'
import { enumeratedControls, enumerateFields, type MeasureFn } from './enumerate'
import { coversDocument, formRegions } from './formRegion'

// Spec #98, ticket #100: the form region is where the Fields are. Its text never
// counts as Job posting text.

/** Visible unless the element says `display: none` itself. */
const inlineMeasure: MeasureFn = (el) => ({
  display: (el as HTMLElement).style.display === 'none' ? 'none' : 'block',
  visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false,
})

const byId = (id: string): Element => document.getElementById(id)!

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('formRegions', () => {
  it('for Controls that share a form element, is the smallest element that holds them all', () => {
    document.body.innerHTML = `
      <form id="f"><h2>Apply</h2>
        <div id="qs"><label>A <input id="a"></label><label>B <textarea id="b"></textarea></label></div>
      </form>`
    expect(formRegions([byId('a'), byId('b')])).toEqual([byId('qs')])
  })

  it('is never larger than that form element', () => {
    document.body.innerHTML = `<main id="m"><form id="f"><input id="a"><input id="b"></form></main>`
    expect(formRegions([byId('a'), byId('b')])).toEqual([byId('f')])
  })

  it('gives one region per form element', () => {
    document.body.innerHTML = `
      <header><form id="search"><input id="q"></form></header>
      <main><form id="apply"><input id="a"><input id="b"></form></main>`
    const regions = formRegions([byId('q'), byId('a'), byId('b')])
    expect(regions).toHaveLength(2)
    expect(regions).toContain(byId('q'))
    expect(regions).toContain(byId('apply'))
  })

  it('for Controls outside any form element, is the smallest element that holds them all', () => {
    document.body.innerHTML = `
      <main><p>Posting</p>
        <div id="loose"><div><input id="a"></div><div><select id="b"></select></div></div>
      </main>`
    expect(formRegions([byId('a'), byId('b')])).toEqual([byId('loose')])
  })

  it('keeps Controls in a form apart from Controls outside every form', () => {
    document.body.innerHTML = `
      <main id="m"><form id="f"><input id="a"><input id="b"></form><div id="loose"><input id="c"><input id="d"></div></main>`
    const regions = formRegions([byId('a'), byId('b'), byId('c'), byId('d')])
    expect(regions).toHaveLength(2)
    expect(regions).toContain(byId('f'))
    expect(regions).toContain(byId('loose'))
  })

  it('finds a form around a Control drawn in a shadow root', () => {
    document.body.innerHTML = `<main><form id="f"><div id="host"></div><input id="b"></form></main>`
    const root = byId('host').attachShadow({ mode: 'open' })
    root.innerHTML = '<input id="a">'
    expect(formRegions([root.getElementById('a')!, byId('b')])).toEqual([byId('f')])
  })

  it('leaves out a Control no longer in the document', () => {
    document.body.innerHTML = `<main><div id="loose"><input id="a"><input id="b"></div></main><input id="gone">`
    const gone = byId('gone')
    gone.remove()
    expect(formRegions([byId('a'), byId('b'), gone])).toEqual([byId('loose')])
  })

  it('has no region without Controls', () => {
    expect(formRegions([])).toEqual([])
  })
})

describe('coversDocument', () => {
  it('is true of the body and the document element, and of nothing inside them', () => {
    document.body.innerHTML = '<main id="m"></main>'
    expect(coversDocument(document.body)).toBe(true)
    expect(coversDocument(document.documentElement)).toBe(true)
    expect(coversDocument(byId('m'))).toBe(false)
  })

  it('is true when loose Controls spread over the whole page', () => {
    document.body.innerHTML = `<header><input id="a"></header><main><input id="b"></main>`
    expect(formRegions([byId('a'), byId('b')]).some(coversDocument)).toBe(true)
  })
})

describe('the Controls an Enumeration found', () => {
  it('are the ones the user can see: a hidden Control is not among them', () => {
    document.body.innerHTML = `<form><input id="a"><select id="b"></select><textarea id="c"></textarea></form><input id="hidden" style="display: none">`
    enumerateFields({ root: document, epoch: 1, measure: inlineMeasure })
    expect(enumeratedControls()).toEqual([byId('a'), byId('b'), byId('c')])
  })

  it('count every radio and every box of a group, not only the first', () => {
    document.body.innerHTML = `
      <fieldset><legend>Size</legend><label><input type="radio" name="s" id="r1">S</label><label><input type="radio" name="s" id="r2">M</label></fieldset>
      <fieldset><legend>Langs</legend><label><input type="checkbox" name="l" id="c1">TS</label><label><input type="checkbox" name="l" id="c2">Go</label></fieldset>`
    enumerateFields({ root: document, epoch: 2, measure: inlineMeasure })
    for (const id of ['r1', 'r2', 'c1', 'c2']) expect(enumeratedControls()).toContain(byId(id))
  })

  it('are replaced by the next Enumeration', () => {
    document.body.innerHTML = `<input id="a">`
    enumerateFields({ root: document, epoch: 3, measure: inlineMeasure })
    document.body.innerHTML = `<input id="b">`
    enumerateFields({ root: document, epoch: 4, measure: inlineMeasure })
    expect(enumeratedControls()).toEqual([byId('b')])
  })
})
