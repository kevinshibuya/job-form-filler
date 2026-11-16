import { describe, it, expect } from 'vitest'
import type { EnumField } from '@jff/shared'
import { enumerateFields, type MeasureFn } from '../content/enumerate'
import { loadRealFixture } from '../content/fixtures/real'
import { dropJunk } from './junk'
import { pickResumeTarget, resumeAttached, scoreResumeField } from './resumeTarget'

const file = (fid: number, patch: Partial<EnumField> = {}): EnumField => ({
  frameId: 1, fid, epoch: 1, label: null, name: null, idAttr: null, kind: 'file',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

describe('scoreResumeField', () => {
  it('scores +3 for a resume/cv/currículo label', () => {
    expect(scoreResumeField(file(0, { label: 'Resume' }))).toBe(3)
    expect(scoreResumeField(file(0, { label: 'Currículo (PDF)' }))).toBe(3)
    expect(scoreResumeField(file(0, { label: 'CV' }))).toBe(3)
    expect(scoreResumeField(file(0, { label: 'Portfolio' }))).toBe(0)
  })

  it('scores +2 for a matching name or id', () => {
    expect(scoreResumeField(file(0, { name: 'resume-upload' }))).toBe(2)
    expect(scoreResumeField(file(0, { idAttr: 'cv_file' }))).toBe(2)
  })

  it('scores +1 for an accept mentioning pdf/doc and +2 for required, summing all terms', () => {
    expect(scoreResumeField(file(0, { accept: '.pdf,.doc,.docx' }))).toBe(1)
    expect(scoreResumeField(file(0, { required: true }))).toBe(2)
    expect(scoreResumeField(file(0, { label: 'Resume', name: 'resume', accept: 'application/pdf', required: true }))).toBe(8)
  })

  it('scores 0 for non-file kinds even with resume-ish labels', () => {
    expect(scoreResumeField({ ...file(0, { label: 'Resume' }), kind: 'text' })).toBe(0)
  })

  it('scores the Ashby autofill pane (unlabelled, optional, no signal) at 0', () => {
    expect(scoreResumeField(file(0))).toBe(0)
  })

  it('scores a cover-letter field 0 whatever its other signals (#37)', () => {
    expect(scoreResumeField(file(0, { idAttr: 'cover_letter', label: 'Attach', accept: '.pdf,.doc' }))).toBe(0)
    expect(scoreResumeField(file(0, { label: 'Cover Letter', required: true, accept: '.pdf' }))).toBe(0)
    expect(scoreResumeField(file(0, { name: 'cover-letter', label: 'Resume or CV' }))).toBe(0)
  })
})

describe('resumeAttached', () => {
  it('is true when an attached upload carries a resume label, and only then', () => {
    expect(resumeAttached(['Resume/CV'])).toBe(true)
    expect(resumeAttached(['Cover Letter', 'Currículo'])).toBe(true)
    expect(resumeAttached(['Cover Letter'])).toBe(false)
    expect(resumeAttached([])).toBe(false)
  })
})

describe('pickResumeTarget', () => {
  it('picks the highest positive scorer, never the first-in-document autofill pane', () => {
    const pane = file(1) // first in document order — the old fields.find() trap
    const real = file(2, { label: 'Resume', required: true, accept: '.pdf' })
    expect(pickResumeTarget([pane, real], [])).toBe(real)
  })

  it('returns null when nothing scores positive (no upload happens)', () => {
    expect(pickResumeTarget([file(1), file(2)], [])).toBeNull()
    expect(pickResumeTarget([], [])).toBeNull()
  })

  it('breaks score ties by document order', () => {
    const a = file(1, { label: 'Resume' })
    const b = file(2, { label: 'CV' })
    expect(pickResumeTarget([a, b], [])).toBe(a)
  })

  it('returns null when the page already shows a resume attached (#37)', () => {
    const real = file(1, { label: 'Resume', required: true })
    expect(pickResumeTarget([real], ['Resume/CV'])).toBeNull()
    expect(pickResumeTarget([real], ['Cover Letter'])).toBe(real)
  })
})

describe('resume target on real-page fixtures', () => {
  const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 200, height: 30, clipped: false })
  const scanFixture = (name: string): { fields: EnumField[]; attachedUploads: string[] } => {
    loadRealFixture(name)
    const { fields, attachedUploads } = enumerateFields({ root: document, epoch: 1, measure: allVisible })
    return { fields: dropJunk(fields), attachedUploads }
  }

  it('greenhouse-hosted-resume-attached: the resume is attached, and no file field is the target', () => {
    const { fields, attachedUploads } = scanFixture('greenhouse-hosted-resume-attached')
    expect(attachedUploads).toEqual(['Resume/CV'])
    const cover = fields.find((f) => f.idAttr === 'cover_letter')!
    expect(cover).toMatchObject({ kind: 'file' })
    expect(scoreResumeField(cover)).toBe(0)
    expect(pickResumeTarget(fields, attachedUploads)).toBeNull()
  })

  it('greenhouse-hosted-b (before the attach): #resume is the target and #cover_letter scores 0', () => {
    const { fields, attachedUploads } = scanFixture('greenhouse-hosted-b')
    expect(attachedUploads).toEqual([])
    expect(pickResumeTarget(fields, attachedUploads)?.idAttr).toBe('resume')
    expect(scoreResumeField(fields.find((f) => f.idAttr === 'cover_letter')!)).toBe(0)
  })

  it("based-in-yes-no (Ashby): the hidden resume input scores positive and is the target", () => {
    const { fields, attachedUploads } = scanFixture('based-in-yes-no')
    const resume = fields.find((f) => f.idAttr === '_systemfield_resume')!
    expect(scoreResumeField(resume)).toBeGreaterThan(0)
    expect(pickResumeTarget(fields, attachedUploads)).toBe(resume)
  })
})
