import { describe, it, expect } from 'vitest'
import type { EnumField } from '@jff/shared'
import { electFrame } from './election'

const field = (frameId: number, fid: number, patch: Partial<EnumField> = {}): EnumField => ({
  frameId, fid, epoch: 1, label: `L${fid}`, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})

describe('electFrame', () => {
  it('scores fields + 3×required + 5×file and picks the highest', () => {
    const e = electFrame([
      field(0, 0), // top frame: 1 plain field -> 1
      field(1, 0), field(1, 1, { required: true }), field(1, 2, { kind: 'file' }), // 3 + 3 + 5 = 11
    ])!
    expect(e.frameId).toBe(1)
    expect(e.score).toBe(11)
    expect(e.scores.find((s) => s.frameId === 0)!.score).toBe(1)
  })

  it('counts hasFile once, not per file input', () => {
    const e = electFrame([field(2, 0, { kind: 'file' }), field(2, 1, { kind: 'file' })])!
    expect(e.score).toBe(2 + 5)
  })

  it('breaks a score tie by most fields', () => {
    // A: 4 plain fields = 4; B: 1 required field = 1 + 3 = 4
    const e = electFrame([
      field(5, 0), field(5, 1), field(5, 2), field(5, 3),
      field(9, 0, { required: true }),
    ])!
    expect(e.frameId).toBe(5)
  })

  it('breaks a full tie by lowest frameId', () => {
    expect(electFrame([field(4, 0), field(4, 1), field(2, 0), field(2, 1)])!.frameId).toBe(2)
  })

  it('the top frame can win on signal (Greenhouse/Lever render in the top document)', () => {
    const e = electFrame([
      field(0, 0), field(0, 1, { required: true }), field(0, 2, { kind: 'file' }),
      field(3, 0),
    ])!
    expect(e.frameId).toBe(0)
  })

  it('elects a single frame as a no-op and returns null for zero fields', () => {
    expect(electFrame([field(0, 0)])!.frameId).toBe(0)
    expect(electFrame([])).toBeNull()
  })
})
