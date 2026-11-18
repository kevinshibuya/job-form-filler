import { describe, it, expect } from 'vitest'
import { atsModule, type EnumField } from '@jff/shared'
import { enumerateFields, type MeasureFn } from '../content/enumerate'
import { loadRealFixture } from '../content/fixtures/real'
import { dropJunk } from './junk'
import { pickResumeTarget } from './resumeTarget'

// #55: Recruitee's hidden per-question file inputs are not Fields. The fixture
// is a Recruitee form whose first custom question can be answered by video: the
// video recorder it embeds draws five file pickers of its own, inside the
// fieldset that holds every custom question. The real uploads, the CV and the
// cover letter, sit above it with their own labels, names and ids.

const RECORDER = '[data-selector="video-recorder-container"]'
const CV_NAME = 'candidate.cv'

const box = (hidden: boolean) =>
  ({ display: 'block', visibility: 'visible', ariaHidden: false, width: hidden ? 1 : 200, height: hidden ? 1 : 30, clipped: hidden })

/** As the live page drew it: the recorder's five pickers hidden, the CV and the
 *  cover letter drawn full size over their drop zones. The capture's cleaning
 *  dropped the recorder's stylesheet, so the fixture alone cannot say this. */
const livePage: MeasureFn = (el) => box(el.getAttribute('type') === 'file' && el.closest(RECORDER) !== null)

/** Stricter: every file picker hidden behind its button, the CV included. */
const everyPickerHidden: MeasureFn = (el) => box(el.getAttribute('type') === 'file')

function scan(measure: MeasureFn, mod = atsModule('recruitee')): { fields: EnumField[]; attachedUploads: string[] } {
  const { fields, attachedUploads } = enumerateFields({ root: document, epoch: 1, measure, atsModule: mod })
  return { fields, attachedUploads }
}

/** The fids Enumeration stamped on the recorder's file pickers. */
function recorderFids(): number[] {
  return Array.from(document.querySelectorAll(`${RECORDER} input[type="file"]`)).map((el) => Number(el.getAttribute('data-jff-fid')))
}

describe.each([
  ['the generic module', undefined],
  ["Recruitee's entry on the list", atsModule('recruitee')],
] as const)('the hidden file inputs of a Recruitee form, with %s', (_, mod) => {
  describe.each([
    ['as the live page drew them', livePage],
    ['with every file picker hidden', everyPickerHidden],
  ] as const)('%s', (_, measure) => {
    it('Enumeration finds the five recorder pickers, hidden, beside the CV and the cover letter', () => {
      loadRealFixture('recruitee-file-inputs')
      const files = scan(measure, mod).fields.filter((f) => f.kind === 'file')
      const recorder = recorderFids()
      expect(recorder).toHaveLength(5)
      expect(files.map((f) => f.fid)).toEqual(expect.arrayContaining(recorder))
      for (const f of files.filter((each) => recorder.includes(each.fid))) {
        expect(f).toMatchObject({ visible: false, name: null, idAttr: null, required: false })
      }
      expect(files.filter((f) => !recorder.includes(f.fid)).map((f) => f.name)).toEqual([CV_NAME, 'candidate.coverLetterFile'])
    })

    it('none of the recorder pickers is among the Fields once the junk filter has run', () => {
      loadRealFixture('recruitee-file-inputs')
      const kept = dropJunk(scan(measure, mod).fields)
      const recorder = recorderFids()
      expect(kept.filter((f) => recorder.includes(f.fid))).toEqual([])
      expect(kept.filter((f) => f.kind === 'file').map((f) => f.name)).toEqual([CV_NAME, 'candidate.coverLetterFile'])
    })

    it('leaves the CV upload a Field and the Resume target', () => {
      loadRealFixture('recruitee-file-inputs')
      const { fields, attachedUploads } = scan(measure, mod)
      const target = pickResumeTarget(dropJunk(fields), attachedUploads)
      expect(target).toMatchObject({ name: CV_NAME, label: 'CV or resume', required: true })
    })
  })

  it('leaves the CV upload the Resume target when its label is gone too', () => {
    // What keeps the CV is what it carries beside its label: a name, an id and
    // a required mark. A rule that dropped every hidden file picker with no
    // label would drop it here.
    loadRealFixture('recruitee-file-inputs')
    document.querySelector(`label[for^="input-${CV_NAME}"]`)!.remove()
    const { fields, attachedUploads } = scan(everyPickerHidden, mod)
    const cv = fields.find((f) => f.name === CV_NAME)!
    expect(cv).toMatchObject({ kind: 'file', visible: false })
    expect(pickResumeTarget(dropJunk(fields), attachedUploads)).toBe(cv)
    expect(dropJunk(fields).filter((f) => recorderFids().includes(f.fid))).toEqual([])
  })
})
