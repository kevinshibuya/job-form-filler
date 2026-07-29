import { describe, it, expect } from 'vitest'
import type { EnumField } from '@jff/shared'
import { dropJunk, keepField } from './junk'

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
})

describe('dropJunk', () => {
  it('filters in order, preserving the kept fields as-is', () => {
    const a = field({ fid: 0 })
    const b = field({ fid: 1, visible: false, label: null })
    const c = field({ fid: 2, kind: 'choice', visible: false })
    expect(dropJunk([a, b, c])).toEqual([a, c])
  })
})
