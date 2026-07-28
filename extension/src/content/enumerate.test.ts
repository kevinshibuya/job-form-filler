import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { enumerateFields, elementByFid, type MeasureFn } from './enumerate'

// jsdom does no layout, so tests drive visibility through the injected measure.
const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30 })

const FIXTURE = resolve(__dirname, '../../../e2e/fixtures/greenhouse-apply/fixture-form.html')

function loadFixture(): void {
  const html = readFileSync(FIXTURE, 'utf8')
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '')
}

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('enumerateFields', () => {
  it('harvests text inputs with labels, types and required flags', () => {
    document.body.innerHTML = `
      <label for="fn">First Name *</label><input id="fn" name="first_name" required>
      <label for="cl">Cover letter</label><textarea id="cl" name="cover"></textarea>`
    const { fields } = enumerateFields({ root: document, epoch: 3, measure: allVisible })
    expect(fields).toHaveLength(2)
    expect(fields[0]).toMatchObject({ frameId: -1, fid: 0, epoch: 3, label: 'First Name', name: 'first_name', kind: 'text', required: true })
    expect(fields[1]).toMatchObject({ fid: 1, label: 'Cover letter', kind: 'textarea', required: false })
  })

  it('coalesces a radio group into ONE field whose options are the radio labels', () => {
    document.body.innerHTML = `
      <fieldset><legend>Work model</legend>
        <label><input type="radio" name="wm" value="r"> Remote</label>
        <label><input type="radio" name="wm" value="h"> Hybrid</label>
        <label><input type="radio" name="wm" value="o"> Onsite</label>
      </fieldset>`
    const { fields } = enumerateFields({ root: document, epoch: 1, measure: allVisible })
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ kind: 'radiogroup', label: 'Work model', options: ['Remote', 'Hybrid', 'Onsite'] })
  })

  it('marks a radio group required when ANY member is required', () => {
    document.body.innerHTML = `
      <fieldset><legend>Pick</legend>
        <label><input type="radio" name="p" value="a"> A</label>
        <label><input type="radio" name="p" value="b" required> B</label>
      </fieldset>`
    expect(enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!.required).toBe(true)
  })

  it('reports the checked radio label as the current value', () => {
    document.body.innerHTML = `
      <fieldset><legend>Pick</legend>
        <label><input type="radio" name="p" value="a"> A</label>
        <label><input type="radio" name="p" value="b" checked> B</label>
      </fieldset>`
    expect(enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!.currentValue).toBe('B')
  })

  it('harvests a native select with its option labels and selected text', () => {
    document.body.innerHTML = `
      <label for="wa">Work Authorization</label>
      <select id="wa" name="work_auth"><option value=""></option><option value="y" selected>Yes I am</option><option value="n">No</option></select>`
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!
    expect(f).toMatchObject({ kind: 'select', options: ['Yes I am', 'No'], currentValue: 'Yes I am' })
  })

  it('classifies an ARIA combobox as kind=combobox and harvests its listbox options', () => {
    document.body.innerHTML = `
      <span id="cl">Country</span>
      <input id="c" role="combobox" aria-labelledby="cl" aria-controls="lb">
      <div id="lb" role="listbox"><div role="option">Brazil</div><div role="option">Portugal</div></div>`
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields
      .find((x) => x.idAttr === 'c')!
    expect(f).toMatchObject({ kind: 'combobox', label: 'Country', options: ['Brazil', 'Portugal'] })
  })

  it('emits an input[role=combobox] exactly ONCE, not as both text and combobox', () => {
    document.body.innerHTML = `<input id="c" aria-label="Country" role="combobox">`
    const fields = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields
    expect(fields).toHaveLength(1)
    expect(fields[0]!.kind).toBe('combobox')
  })

  it('classifies checkbox and file inputs', () => {
    document.body.innerHTML = `
      <label><input type="checkbox" id="att" checked> I certify</label>
      <label for="cv">Resume</label><input type="file" id="cv" name="resume">`
    const fields = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields
    expect(fields.find((f) => f.idAttr === 'att')).toMatchObject({ kind: 'checkbox', currentValue: 'true' })
    expect(fields.find((f) => f.idAttr === 'cv')).toMatchObject({ kind: 'file' })
  })

  it('skips hidden, submit, button and reset inputs', () => {
    document.body.innerHTML = `
      <input type="hidden" name="csrf"><input type="submit" value="Go">
      <input type="button" value="X"><input type="reset" value="R"><input name="real">`
    const fields = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields
    expect(fields).toHaveLength(1)
    expect(fields[0]!.name).toBe('real')
  })

  it('always treats a file input as visible even when the page hides it', () => {
    document.body.innerHTML = `<label for="cv">Resume</label><input type="file" id="cv">`
    const measure: MeasureFn = () => ({ display: 'none', visibility: 'hidden', ariaHidden: false, width: 0, height: 0 })
    expect(enumerateFields({ root: document, epoch: 1, measure }).fields[0]!.visible).toBe(true)
  })

  it('marks non-file fields hidden when display:none, visibility:hidden or aria-hidden', () => {
    document.body.innerHTML = `<label for="x">X</label><input id="x">`
    const measure: MeasureFn = () => ({ display: 'none', visibility: 'visible', ariaHidden: false, width: 0, height: 0 })
    expect(enumerateFields({ root: document, epoch: 1, measure }).fields[0]!.visible).toBe(false)
  })

  it('stamps data-jff-fid so elementByFid can find the element again', () => {
    document.body.innerHTML = `<label for="a">A</label><input id="a"><label for="b">B</label><input id="b">`
    enumerateFields({ root: document, epoch: 1, measure: allVisible })
    expect(document.getElementById('b')!.getAttribute('data-jff-fid')).toBe('1')
    expect(elementByFid(document, 1)!.id).toBe('b')
  })

  it('clears stale fids and renumbers from zero on a re-scan', () => {
    document.body.innerHTML = `<label for="a">A</label><input id="a"><label for="b">B</label><input id="b">`
    enumerateFields({ root: document, epoch: 1, measure: allVisible })
    document.getElementById('a')!.remove()
    enumerateFields({ root: document, epoch: 2, measure: allVisible })
    expect(document.getElementById('b')!.getAttribute('data-jff-fid')).toBe('0')
    expect(document.querySelectorAll('[data-jff-fid]')).toHaveLength(1)
  })

  it('enumerates fields inside an OPEN shadow root', () => {
    const hostEl = document.createElement('my-widget')
    document.body.appendChild(hostEl)
    hostEl.attachShadow({ mode: 'open' }).innerHTML = '<label for="s">Shadow Field</label><input id="s" name="shadow">'
    const fields = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields
    expect(fields.find((f) => f.name === 'shadow')).toMatchObject({ label: 'Shadow Field' })
  })

  it('reports the count of unreachable (closed shadow root) widgets', () => {
    const hostEl = document.createElement('closed-widget')
    document.body.appendChild(hostEl)
    hostEl.attachShadow({ mode: 'closed' })
    expect(enumerateFields({ root: document, epoch: 1, measure: allVisible }).unreachableWidgets).toBe(1)
  })

  it('survives the real Greenhouse fixture and finds its core fields', () => {
    loadFixture()
    const { fields } = enumerateFields({ root: document, epoch: 9, measure: allVisible })
    const names = fields.map((f) => f.name)
    expect(names).toEqual(expect.arrayContaining(['first_name', 'last_name', 'email', 'resume', 'work_auth', 'attestation', 'hard_bug']))
    expect(fields.find((f) => f.name === 'work_auth')!.options.length).toBe(2)
    // the label-only LinkedIn field has no name but IS bound by its label
    expect(fields.find((f) => f.idAttr === 'linkedin-input')!.label).toBe('LinkedIn Profile')
    // the unbindable "mystery" field still gets a handle, with a null label
    expect(fields.find((f) => f.idAttr === 'mystery')).toMatchObject({ label: null, required: true })
    expect(fields.every((f) => f.epoch === 9)).toBe(true)
  })
})
