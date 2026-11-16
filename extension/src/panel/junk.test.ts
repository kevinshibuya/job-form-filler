import { describe, it, expect } from 'vitest'
import type { EnumField } from '@jff/shared'
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
