import { describe, it, expect } from 'vitest'
import { atsModule, type EnumField } from '@jff/shared'
import { enumerateFields, type MeasureFn } from '../content/enumerate'
import { loadRealFixture } from '../content/fixtures/real'
import { dropJunk } from './junk'
import { pickResumeTarget } from './resumeTarget'

// #54: Ashby's "Autofill from resume" upload is not a Field. The fixture is an
// Ashby form that shows the autofill upload above the real Resume upload. Both
// pickers are hidden behind their buttons, as Ashby clips them.
const pageHidden: MeasureFn = (el) => {
  const hidden = el.getAttribute('type') === 'file'
  return { display: 'block', visibility: 'visible', ariaHidden: false, width: hidden ? 1 : 200, height: hidden ? 1 : 30, clipped: hidden }
}

const FIXTURE = 'based-in-yes-no'
const AUTOFILL_ROOT = '.ashby-application-form-autofill-input-root'

function scan(mod = atsModule('ashby')): { fields: EnumField[]; attachedUploads: string[] } {
  const { fields, attachedUploads } = enumerateFields({ root: document, epoch: 1, measure: pageHidden, atsModule: mod })
  return { fields, attachedUploads }
}

/** The fid Enumeration stamped on the autofill pane's file picker. */
function autofillFid(): number {
  const input = document.querySelector(`${AUTOFILL_ROOT} input[type="file"]`)!
  return Number(input.getAttribute('data-jff-fid'))
}

describe.each([
  ['the generic module', undefined],
  ["Ashby's module", atsModule('ashby')],
] as const)('the Ashby autofill upload, with %s', (_, mod) => {
  it('Enumeration finds two file pickers: the autofill upload and the Resume upload', () => {
    loadRealFixture(FIXTURE)
    const files = scan(mod).fields.filter((f) => f.kind === 'file')
    expect(files.map((f) => f.fid)).toEqual([autofillFid(), files[1]!.fid])
    expect(files[1]).toMatchObject({ idAttr: '_systemfield_resume', label: 'Resume' })
  })

  it('is not among the Fields once the junk filter has run', () => {
    loadRealFixture(FIXTURE)
    const kept = dropJunk(scan(mod).fields)
    expect(kept.map((f) => f.fid)).not.toContain(autofillFid())
    expect(kept.filter((f) => f.kind === 'file').map((f) => f.idAttr)).toEqual(['_systemfield_resume'])
  })

  it('leaves the real Resume upload the Resume target', () => {
    loadRealFixture(FIXTURE)
    const { fields, attachedUploads } = scan(mod)
    expect(pickResumeTarget(dropJunk(fields), attachedUploads)?.idAttr).toBe('_systemfield_resume')
  })

  it('leaves the real Resume upload the Resume target when its label is gone too', () => {
    // What keeps the Resume is what it carries beside its label: an id and a
    // required mark. A rule that dropped every hidden file picker with no label
    // would drop it here.
    loadRealFixture(FIXTURE)
    document.querySelector('label[for="_systemfield_resume"]')!.remove()
    const { fields, attachedUploads } = scan(mod)
    const resume = fields.find((f) => f.idAttr === '_systemfield_resume')!
    expect(resume).toMatchObject({ kind: 'file', label: null, visible: false })
    expect(pickResumeTarget(dropJunk(fields), attachedUploads)).toBe(resume)
    expect(dropJunk(fields).map((f) => f.fid)).not.toContain(autofillFid())
  })
})
