import { describe, it, expect } from 'vitest'
import { atsModule, type EnumField } from '@jff/shared'
import { enumerateFields, type MeasureFn } from '../content/enumerate'
import { loadRealFixture } from '../content/fixtures/real'
import { dropJunk, keepField } from './junk'
import { scoreResumeField } from './resumeTarget'

const field = (patch: Partial<EnumField>): EnumField => ({
  frameId: 0, fid: 0, epoch: 1, label: 'L', name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

describe('keepField', () => {
  it('keeps every visible field', () => {
    expect(keepField(field({}))).toBe(true)
    expect(keepField(field({ kind: 'file', label: null }))).toBe(true)
  })

  it('drops hidden junk: the reCAPTCHA response textarea', () => {
    expect(keepField(field({ kind: 'textarea', visible: false, label: null, name: 'g-recaptcha-response' }))).toBe(false)
  })

  it('drops a hidden unlabelled text input', () => {
    expect(keepField(field({ visible: false, label: null }))).toBe(false)
  })

  it('keeps choice fields (their backing input is hidden BY DESIGN)', () => {
    expect(keepField(field({ kind: 'choice', visible: false, options: ['Yes', 'No'] }))).toBe(true)
  })

  it('keeps hidden checkboxes/radios WITH a resolvable label (styled-control recipe)', () => {
    expect(keepField(field({ kind: 'checkbox', visible: false, label: 'I agree to the ToS' }))).toBe(true)
    expect(keepField(field({ kind: 'radiogroup', visible: false, label: 'Work model' }))).toBe(true)
    expect(keepField(field({ kind: 'checkbox', visible: false, label: null }))).toBe(false)
  })

  it('keeps a hidden checkbox group with a label as a row, as it keeps a hidden lone checkbox', () => {
    const group = { kind: 'checkboxgroup' as const, visible: false, options: ['He/him', 'She/her'] }
    expect(keepField(field({ ...group, label: 'Pronouns' }))).toBe(true)
    expect(keepField(field({ ...group, label: null }))).toBe(false)
  })

  it('keeps hidden file inputs ONLY with a resolvable label (no blanket exemption)', () => {
    expect(keepField(field({ kind: 'file', visible: false, label: 'Resume' }))).toBe(true)
    expect(keepField(field({ kind: 'file', visible: false, label: null }))).toBe(false)
  })

  it('keeps a hidden unlabelled file input that scores on the resume scorer (A8 seam)', () => {
    expect(keepField(field({ kind: 'file', visible: false, label: null, name: 'resume-upload' }))).toBe(true)
    expect(keepField(field({ kind: 'file', visible: false, label: null, required: true }))).toBe(true)
    // no label AND no scoring signal: still junk (the autofill-pane trap)
    expect(keepField(field({ kind: 'file', visible: false, label: null }))).toBe(false)
  })

  it('keeps a hidden file input whose only label was an upload wording, though it now has no label (#46)', () => {
    // Greenhouse's "Attach" pickers carry an id; #55 keeps only a picker that says what it is for.
    expect(keepField(field({ kind: 'file', visible: false, label: null, idAttr: 'resume', uploadWordingOnly: true }))).toBe(true)
    expect(keepField(field({ kind: 'text', visible: false, label: null, idAttr: 'resume', uploadWordingOnly: true }))).toBe(false)
  })

  it('drops a hidden picker with no label, no name and no id whose only file signal is its accept (#54)', () => {
    const autofill = field({ kind: 'file', visible: false, label: null, accept: 'application/pdf,.pdf,.doc,.docx' })
    expect(keepField(autofill)).toBe(false)
    expect(keepField({ ...autofill, idAttr: '_systemfield_resume' })).toBe(true)
    expect(keepField({ ...autofill, name: 'attachment' })).toBe(true)
    expect(keepField({ ...autofill, required: true })).toBe(true)
    expect(keepField({ ...autofill, label: 'Resume' })).toBe(true)
    // #55: upload wording alone does not keep it either.
    expect(keepField({ ...autofill, uploadWordingOnly: true })).toBe(false)
    expect(keepField({ ...autofill, visible: true })).toBe(true)
  })

  it('drops a hidden picker with no name, no id and no required mark whose only label source was its upload button\'s words (#55)', () => {
    const recorder = field({ kind: 'file', visible: false, label: null, uploadWordingOnly: true, accept: '.mp4,.mov,.webm' })
    expect(keepField(recorder)).toBe(false)
    expect(keepField({ ...recorder, idAttr: 'resume' })).toBe(true)
    expect(keepField({ ...recorder, name: 'portfolio' })).toBe(true)
    expect(keepField({ ...recorder, required: true })).toBe(true)
    expect(keepField({ ...recorder, label: 'Video answer' })).toBe(true)
    expect(keepField({ ...recorder, visible: true })).toBe(true)
  })

  it('keeps a hidden unlabelled cover-letter input on its file signals, though it is no resume target (#37)', () => {
    const cover = field({ kind: 'file', visible: false, label: null, idAttr: 'cover_letter', accept: '.pdf,.doc,.docx,.txt,.rtf' })
    expect(scoreResumeField(cover)).toBe(0)
    expect(keepField(cover)).toBe(true)
  })
})

describe('dropJunk', () => {
  it('filters in order, preserving the kept fields as-is', () => {
    const a = field({ fid: 0 })
    const b = field({ fid: 1, visible: false, label: null })
    const c = field({ fid: 2, kind: 'choice', visible: false })
    expect(dropJunk([a, b, c])).toEqual([a, c])
  })
})

describe('the junk filter over the real-page fixtures (#46)', () => {
  // The page hides a file picker behind its button, and a class or
  // aria-hidden hides the rest; everything else is visible.
  const pageHidden: MeasureFn = (el) => {
    const hidden = el.getAttribute('type') === 'file' || el.getAttribute('aria-hidden') === 'true'
      || /hidden/.test(el.getAttribute('class') ?? '')
    return { display: 'block', visibility: 'visible', ariaHidden: el.getAttribute('aria-hidden') === 'true', width: hidden ? 1 : 200, height: hidden ? 1 : 30, clipped: hidden }
  }

  // Pinned from a run on the code before the generic label rules. #54 drops
  // Ashby's autofill upload (fid 0) and nothing else on any fixture. #55 drops
  // the five pickers of Recruitee's video recorder (fids 5 to 9) and nothing
  // else on any fixture; fid 10, the recorder question's aria-hidden text box,
  // was dropped before it.
  it.each([
    ['based-in-yes-no', 'ashby', [0], [0]],
    ['greenhouse-accommodation', 'greenhouse', [9, 11, 15, 17], [9, 11, 15, 17]],
    ['greenhouse-hosted-a', 'greenhouse', [3, 6, 15, 17], [3, 6, 15, 17]],
    ['greenhouse-hosted-b', 'greenhouse', [4, 7, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32], [4, 7, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]],
    ['greenhouse-hosted-resume-attached', 'greenhouse', [7, 9, 13, 16, 18, 20, 22], [7, 9, 13, 16, 18, 20, 22]],
    ['greenhouse-hosted-resume-uploading', 'greenhouse', [7, 9, 13, 16, 18, 20, 22], [7, 9, 13, 16, 18, 20, 22]],
    ['greenhouse-self-id', 'greenhouse', [3, 6, 10, 15, 17, 21, 29, 31, 33, 35, 37, 39, 41], [3, 6, 10, 15, 17, 21, 29, 31, 33, 35, 37, 39, 41]],
    ['lever-marketing-consent', 'lever', [20], []],
    ['lever-pronoun-group', 'lever', [], []],
    ['lever-source-group', 'lever', [], []],
    ['recruitee-file-inputs', 'recruitee', [5, 6, 7, 8, 9, 10], [5, 6, 7, 8, 9, 10]],
  ] as const)('%s: drops the same Fields as before, with the generic module and with %s\'s', (name, ats, genericDrops, moduleDrops) => {
    for (const [mod, drops] of [[undefined, genericDrops], [atsModule(ats), moduleDrops]] as const) {
      loadRealFixture(name)
      const { fields } = enumerateFields({ root: document, epoch: 1, measure: pageHidden, atsModule: mod })
      expect(fields.filter((f) => !keepField(f)).map((f) => f.fid)).toEqual(drops)
    }
  })
})
