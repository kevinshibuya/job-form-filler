import { describe, it, expect } from 'vitest'
import type { EnumField, Resolution } from '@jff/shared'
import { buildRows, FOREIGN_REASON, groupRows, refOf, SOURCE_BADGE } from './group'

const field = (fid: number, label: string, frameId = 0): EnumField => ({
  frameId, fid, epoch: 1, label, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false,
})
const resolution = (fid: number, patch: Partial<Resolution>): Resolution => ({
  handle: { frameId: 0, fid, epoch: 1 }, tier: 'needs_input', value: null,
  source: null, key: null, answerId: null, reason: 'custom', ...patch,
})

describe('groupRows', () => {
  const fields = [field(0, 'Email'), field(1, 'Salary'), field(2, 'Why us?'), field(3, 'Gender')]
  const resolutions = [
    resolution(0, { tier: 'auto', value: 'k@x.com', source: 'profile' }),
    resolution(1, { tier: 'proposed', value: 'R$ 18k', source: 'llm_key' }),
    resolution(2, { tier: 'needs_input' }),
    resolution(3, { tier: 'skipped', reason: 'eeo' }),
  ]

  it('puts every field in exactly one bucket', () => {
    const g = groupRows(fields, resolutions)
    expect(g.auto.map((r) => r.field.label)).toEqual(['Email'])
    expect(g.proposed.map((r) => r.field.label)).toEqual(['Salary'])
    expect(g.needs_input.map((r) => r.field.label)).toEqual(['Why us?'])
    expect(g.skipped.map((r) => r.field.label)).toEqual(['Gender'])
  })

  it('drops a field with no matching resolution rather than guessing', () => {
    const g = groupRows([...fields, field(9, 'Orphan')], resolutions)
    const all = [...g.auto, ...g.proposed, ...g.needs_input, ...g.skipped]
    expect(all.map((r) => r.field.label)).not.toContain('Orphan')
  })

  it('matches resolutions by the full handle, not by array position', () => {
    const g = groupRows([field(1, 'Salary'), field(0, 'Email')], resolutions)
    expect(g.auto[0]!.field.label).toBe('Email')
    expect(g.proposed[0]!.field.label).toBe('Salary')
  })
})

describe('buildRows', () => {
  const fields = [
    field(0, 'Newsletter email', 0),
    field(0, 'First name', 1),
    field(1, 'Why us?', 1),
    field(2, 'Gender', 1),
  ]
  const resolutions = [
    resolution(0, { handle: { frameId: 1, fid: 0, epoch: 1 }, tier: 'auto', value: 'Kevin', source: 'profile' }),
    resolution(1, { handle: { frameId: 1, fid: 1, epoch: 1 }, tier: 'needs_input' }),
    resolution(2, { handle: { frameId: 1, fid: 2, epoch: 1 }, tier: 'skipped', reason: 'eeo' }),
  ]

  it('splits elected rows from foreign rows and keeps document order (NO tier bucketing)', () => {
    const { main, foreign } = buildRows(fields, resolutions, 1)
    expect(main.map((r) => r.field.label)).toEqual(['First name', 'Why us?', 'Gender'])
    expect(main.map((r) => r.resolution.tier)).toEqual(['auto', 'needs_input', 'skipped'])
    expect(foreign.map((r) => r.field.label)).toEqual(['Newsletter email'])
  })

  it('mints the exact synthetic other-frame resolution for foreign fields', () => {
    const { foreign } = buildRows(fields, resolutions, 1)
    expect(foreign[0]!.resolution).toEqual({
      handle: { frameId: 0, fid: 0, epoch: 1 },
      tier: 'needs_input', value: null, source: null, key: null, answerId: null,
      reason: FOREIGN_REASON,
    })
  })

  it('keeps the skipped affordance for a FOREIGN demographic field', () => {
    const demo = { ...field(7, 'Gender', 0), demographic: true }
    const { foreign } = buildRows([demo], resolutions, 1)
    expect(foreign[0]!.resolution).toMatchObject({ tier: 'skipped', reason: 'eeo' })
  })

  it('treats every field as main when no election happened', () => {
    const { main, foreign } = buildRows(fields, resolutions, null)
    expect(foreign).toEqual([])
    // the newsletter field has no resolution -> still dropped, never guessed
    expect(main.map((r) => r.field.label)).toEqual(['First name', 'Why us?', 'Gender'])
  })

  it('still drops an elected-frame field with no resolution rather than guessing', () => {
    const { main } = buildRows([...fields, field(9, 'Orphan', 1)], resolutions, 1)
    expect(main.map((r) => r.field.label)).not.toContain('Orphan')
  })
})

describe('refOf', () => {
  it('formats frameId:fid', () => {
    expect(refOf({ frameId: 2, fid: 5, epoch: 9 })).toBe('2:5')
  })
})

describe('SOURCE_BADGE', () => {
  it('labels every source with human copy and no spaced em-dashes', () => {
    expect(SOURCE_BADGE.profile).toBe('profile')
    expect(SOURCE_BADGE.answer_bank).toBe('saved fact')
    expect(SOURCE_BADGE.saved_answer).toBe('saved answer')
    expect(SOURCE_BADGE.llm_key).toBe('AI match')
    expect(SOURCE_BADGE.llm_reuse).toBe('AI reuse')
    expect(SOURCE_BADGE.page).toBe('already on page')
    for (const v of Object.values(SOURCE_BADGE)) expect(v).not.toMatch(/\s[—–]\s/)
  })
})
