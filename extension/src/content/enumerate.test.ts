import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { enumerateFields, elementByFid, detectChoice, isClipped, CHOICE_MAX_OPTION_CHARS, type MeasureFn } from './enumerate'
import {
  ASHBY_CHOICE_RADIO, ASHBY_COMBOBOX, ASHBY_COMBOBOX_WITH_DESCRIPTION, ASHBY_CONSENT_SINGLE,
  ASHBY_EEO_YESNO, ASHBY_ESSAY_WITH_DESCRIPTION, ASHBY_OPTIONAL_FIELD, ASHBY_RADIO_FIELDSET,
  ASHBY_YESNO_EN, ASHBY_YESNO_PT, SELECT_WITH_PLACEHOLDER, SHARED_WRAPPER_FIRST_LAST,
  STAR_REQUIRED_FIELD, STYLED_HIDDEN_CHECKBOX,
} from './fixtures/ashby'

// jsdom does no layout, so tests drive visibility through the injected measure.
const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })

/** Hides checkbox/radio inputs the way Ashby's CSS does; everything else visible. */
const hideToggles: MeasureFn = (el) => ({
  display: el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? 'none' : 'block',
  visibility: 'visible', ariaHidden: false, width: 100, height: 20, clipped: false,
})

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

  it('records honest visibility for file inputs (the panel decides what to keep)', () => {
    document.body.innerHTML = `<label for="cv">Resume</label><input type="file" id="cv">`
    const measure: MeasureFn = () => ({ display: 'none', visibility: 'hidden', ariaHidden: false, width: 0, height: 0, clipped: false })
    const f = enumerateFields({ root: document, epoch: 1, measure }).fields[0]!
    expect(f.visible).toBe(false)
    expect(f.label).toBe('Resume') // the panel keeps it via this label
  })

  it('counts CLIPPED as not visible — the Ashby autofill pane is a hidden file input', () => {
    // The pane's real recipe: laid out and displayed, but clipped to nothing.
    document.body.innerHTML = `<input type="file" class="visually-hidden">`
    const measure: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 1, height: 1, clipped: true })
    const f = enumerateFields({ root: document, epoch: 1, measure }).fields[0]!
    expect(f.visible).toBe(false)
    expect(f.label).toBeNull() // unlabelled + hidden => the panel filter drops it (Task 10)
  })

  it('marks non-file fields hidden when display:none, visibility:hidden or aria-hidden', () => {
    document.body.innerHTML = `<label for="x">X</label><input id="x">`
    const measure: MeasureFn = () => ({ display: 'none', visibility: 'visible', ariaHidden: false, width: 0, height: 0, clipped: false })
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

describe('isClipped', () => {
  it('flags the 1px visually-hidden box', () => {
    expect(isClipped(1, 1, '', '')).toBe(true)
    expect(isClipped(0, 0, '', '')).toBe(true)
    expect(isClipped(200, 30, '', '')).toBe(false)
  })

  it('flags clip:rect(0 0 0 0) and clip-path:inset(50%|100%)', () => {
    expect(isClipped(200, 30, 'rect(0px, 0px, 0px, 0px)', '')).toBe(true)
    expect(isClipped(200, 30, '', 'inset(50%)')).toBe(true)
    expect(isClipped(200, 30, '', 'inset(100%)')).toBe(true)
    expect(isClipped(200, 30, 'auto', 'none')).toBe(false)
  })
})

describe('detectChoice', () => {
  it('detects the Ashby yes/no checkbox pattern with verbatim button texts', () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    const d = detectChoice(document.querySelector('input[type="checkbox"]')!)
    expect(d).not.toBeNull()
    expect(d!.options).toEqual(['Yes', 'No'])
    expect(d!.buttons).toHaveLength(2)
  })

  it('captures i18n option texts verbatim, never boolean-mapped', () => {
    document.body.innerHTML = ASHBY_YESNO_PT
    expect(detectChoice(document.querySelector('input[type="checkbox"]')!)!.options).toEqual(['Sim', 'Não'])
  })

  it('detects the radio-backed variant (radios sharing a name count as one control)', () => {
    document.body.innerHTML = ASHBY_CHOICE_RADIO
    const d = detectChoice(document.querySelector('input[type="radio"]')!)
    expect(d).not.toBeNull()
    expect(d!.options).toEqual(['Yes', 'No'])
  })

  it('returns null for a styled hidden checkbox with no sibling buttons', () => {
    document.body.innerHTML = STYLED_HIDDEN_CHECKBOX
    expect(detectChoice(document.getElementById('tos-check')!)).toBeNull()
  })

  it('returns null for a toolbar (too many buttons)', () => {
    document.body.innerHTML = `
      <div><input type="checkbox" id="tb">
        <button>A</button><button>B</button><button>C</button><button>D</button><button>E</button><button>F</button>
      </div>`
    expect(detectChoice(document.getElementById('tb')!)).toBeNull()
  })

  it('returns null when a button text exceeds the option cap', () => {
    document.body.innerHTML = `
      <div><input type="checkbox" id="lg2">
        <button>Yes</button><button>${'n'.repeat(CHOICE_MAX_OPTION_CHARS + 1)}</button>
      </div>`
    expect(detectChoice(document.getElementById('lg2')!)).toBeNull()
  })

  it('returns null when the wrapper holds another enumerable control', () => {
    document.body.innerHTML = `
      <div><input type="checkbox" id="oc"><button>Yes</button><button>No</button><input type="text"></div>`
    expect(detectChoice(document.getElementById('oc')!)).toBeNull()
  })

  it('returns null for non-checkbox/radio elements', () => {
    document.body.innerHTML = '<div><input type="text" id="tx"><button>A</button><button>B</button></div>'
    expect(detectChoice(document.getElementById('tx')!)).toBeNull()
  })
})

describe('enumerateFields — Ashby label recovery (A1/A2)', () => {
  it('labels the dangling-label combobox with the question, required via class token', () => {
    document.body.innerHTML = ASHBY_COMBOBOX
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!
    expect(f).toMatchObject({ kind: 'combobox', label: 'Select your country of employment', required: true })
    expect(f.label).not.toBe('Start typing...')
  })

  it('keeps distinct labels for two inputs under one wrapper', () => {
    document.body.innerHTML = SHARED_WRAPPER_FIRST_LAST
    const { fields } = enumerateFields({ root: document, epoch: 1, measure: allVisible })
    expect(fields.map((f) => f.label)).toEqual(['First name', 'Last name'])
  })

  it('leaves the optional field required:false', () => {
    document.body.innerHTML = ASHBY_OPTIONAL_FIELD
    expect(enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!.required).toBe(false)
  })

  it('marks required from a literal * in the raw label text', () => {
    document.body.innerHTML = STAR_REQUIRED_FIELD
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!
    expect(f).toMatchObject({ label: 'Phone', required: true })
  })

  it('labels the radio fieldset with the question and the options with the radio labels', () => {
    document.body.innerHTML = ASHBY_RADIO_FIELDSET
    const { fields } = enumerateFields({ root: document, epoch: 1, measure: allVisible })
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({
      kind: 'radiogroup',
      label: 'Have you previously worked in a remote or hybrid environment?',
      options: ['Yes, fully remote', 'Yes, hybrid', 'No'],
      required: true,
    })
  })

  it('labels the single-option consent with the policy statement, option "I agree"', () => {
    document.body.innerHTML = ASHBY_CONSENT_SINGLE
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!
    expect(f.label).toMatch(/^By submitting your application/)
    expect(f.options).toEqual(['I agree'])
  })
})

describe('enumerateFields — choice kind (A3)', () => {
  it('enumerates the hidden yes/no checkbox as ONE choice field with button-text options', () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    const { fields } = enumerateFields({ root: document, epoch: 1, measure: hideToggles })
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({
      kind: 'choice',
      label: 'Are you legally authorized to work in your current country of employment?',
      options: ['Yes', 'No'],
      required: true,
      currentValue: null,
    })
    // fid is stamped on the hidden input: the filler re-finds the buttons from it
    expect(document.querySelector('input[type="checkbox"]')!.getAttribute('data-jff-fid')).toBe('0')
  })

  it('captures Sim/Não verbatim', () => {
    document.body.innerHTML = ASHBY_YESNO_PT
    expect(enumerateFields({ root: document, epoch: 1, measure: hideToggles }).fields[0]!.options).toEqual(['Sim', 'Não'])
  })

  it('enumerates the radio-backed variant as ONE choice field, not a radiogroup', () => {
    document.body.innerHTML = ASHBY_CHOICE_RADIO
    const { fields } = enumerateFields({ root: document, epoch: 1, measure: hideToggles })
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ kind: 'choice', options: ['Yes', 'No'] })
  })

  it('keeps a styled hidden checkbox with a resolvable label as kind checkbox', () => {
    document.body.innerHTML = STYLED_HIDDEN_CHECKBOX
    const f = enumerateFields({ root: document, epoch: 1, measure: hideToggles }).fields[0]!
    expect(f).toMatchObject({ kind: 'checkbox', label: 'I agree to the terms of service' })
  })

  it('a VISIBLE checkbox near buttons stays a checkbox (self-hidden gate)', () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!
    expect(f.kind).toBe('checkbox')
  })
})

describe('enumerateFields — demographic by recovered label (A1)', () => {
  it('marks the EEO yes/no choice demographic from its recovered label alone', () => {
    document.body.innerHTML = ASHBY_EEO_YESNO
    const f = enumerateFields({ root: document, epoch: 1, measure: hideToggles }).fields[0]!
    expect(f.kind).toBe('choice')
    expect(f.demographic).toBe(true)
  })

  it('still honors the injected isDemographic', () => {
    document.body.innerHTML = '<label for="x">Favorite color</label><input id="x">'
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible, isDemographic: () => true }).fields[0]!
    expect(f.demographic).toBe(true)
  })
})

describe('enumerateFields — description capture (A4)', () => {
  it('captures the essay sibling description', () => {
    document.body.innerHTML = ASHBY_ESSAY_WITH_DESCRIPTION
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!
    expect(f.description).toBe('Please include: • What made it challenging? • The total timeline from start to finish')
  })

  it("captures the combobox's uncle description", () => {
    document.body.innerHTML = ASHBY_COMBOBOX_WITH_DESCRIPTION
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!
    expect(f.description).toBe('If unsure, choose the option that most closely matches your experience.')
  })

  it('leaves description undefined when there is none', () => {
    document.body.innerHTML = ASHBY_OPTIONAL_FIELD
    expect(enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!.description).toBeUndefined()
  })
})

describe('enumerateFields — select placeholder (A5)', () => {
  it('yields currentValue null for a selected empty-value "Select…" option', () => {
    document.body.innerHTML = SELECT_WITH_PLACEHOLDER
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!
    expect(f.currentValue).toBeNull()
    expect(f.options).toContain('Brazil')
  })

  it('yields currentValue null for a selected DISABLED option', () => {
    document.body.innerHTML = `
      <label for="s2">Country</label>
      <select id="s2"><option disabled selected>Choose</option><option value="br">Brazil</option></select>`
    expect(enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!.currentValue).toBeNull()
  })

  it('still reports a real selection', () => {
    document.body.innerHTML = `
      <label for="s3">Country</label>
      <select id="s3"><option value="">Select…</option><option value="br" selected>Brazil</option></select>`
    expect(enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!.currentValue).toBe('Brazil')
  })
})

describe('enumerateFields — file accept capture (A8)', () => {
  it('captures the accept attribute on file inputs', () => {
    document.body.innerHTML = '<label for="cv">Resume</label><input type="file" id="cv" accept=".pdf,.doc,.docx">'
    const f = enumerateFields({ root: document, epoch: 1, measure: allVisible }).fields[0]!
    expect(f.accept).toBe('.pdf,.doc,.docx')
  })

  it('leaves accept undefined for non-file kinds and accept-less file inputs', () => {
    document.body.innerHTML = `
      <label for="x">Name</label><input id="x" type="text" accept=".pdf">
      <label for="y">Portfolio</label><input type="file" id="y">`
    const { fields } = enumerateFields({ root: document, epoch: 1, measure: allVisible })
    expect(fields[0]!.accept).toBeUndefined()
    expect(fields[1]!.accept).toBeUndefined()
  })
})
