import { describe, it, expect } from 'vitest'
import {
  EnumFieldSchema, isCheckboxGroup, isConsentCheckbox, optionSetLabels, optionSetValue, type EnumField,
} from './field.js'

const field = (patch: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid: 0, epoch: 1, label: 'Pronouns', name: 'pronouns', idAttr: null,
  kind: 'checkboxgroup', options: ['He/him', 'She/her', 'They/them'], required: false,
  visible: true, currentValue: null, demographic: false, ...patch,
})

describe('a checkbox group is one Field with a multi-choice Control', () => {
  it('a checkbox group Field passes the Field schema with its question and Options', () => {
    const parsed = EnumFieldSchema.parse(field({ currentValue: 'She/her\nThey/them' }))
    expect(parsed.kind).toBe('checkboxgroup')
    expect(parsed.label).toBe('Pronouns')
    expect(parsed.options).toEqual(['He/him', 'She/her', 'They/them'])
  })

  it('a checkbox group is not a Consent checkbox, and a lone checkbox is not a group', () => {
    expect(isCheckboxGroup(field())).toBe(true)
    expect(isConsentCheckbox(field())).toBe(false)
    expect(isCheckboxGroup(field({ kind: 'checkbox', options: [] }))).toBe(false)
    expect(isConsentCheckbox(field({ kind: 'checkbox', options: [] }))).toBe(true)
  })
})

describe('the Value of a multi-choice Control travels as its labels joined by a newline', () => {
  it('a set of Option labels becomes one line per label, in the order given', () => {
    expect(optionSetValue(['She/her', 'They/them'])).toBe('She/her\nThey/them')
    expect(optionSetValue([])).toBe('')
  })

  it('a Value read back as text yields its labels, without blank lines or stray spaces', () => {
    expect(optionSetLabels('She/her\nThey/them')).toEqual(['She/her', 'They/them'])
    expect(optionSetLabels('  She/her \n\n They/them\r\n')).toEqual(['She/her', 'They/them'])
    expect(optionSetLabels('')).toEqual([])
  })
})
