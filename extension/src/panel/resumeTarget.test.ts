import { describe, it, expect } from 'vitest'
import type { EnumField } from '@jff/shared'
import { pickResumeTarget, scoreResumeField } from './resumeTarget'

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
})

describe('pickResumeTarget', () => {
  it('picks the highest positive scorer, never the first-in-document autofill pane', () => {
    const pane = file(1) // first in document order — the old fields.find() trap
    const real = file(2, { label: 'Resume', required: true, accept: '.pdf' })
    expect(pickResumeTarget([pane, real])).toBe(real)
  })

  it('returns null when nothing scores positive (no upload happens)', () => {
    expect(pickResumeTarget([file(1), file(2)])).toBeNull()
    expect(pickResumeTarget([])).toBeNull()
  })

  it('breaks score ties by document order', () => {
    const a = file(1, { label: 'Resume' })
    const b = file(2, { label: 'CV' })
    expect(pickResumeTarget([a, b])).toBe(a)
  })
})
