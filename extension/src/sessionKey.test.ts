import { describe, expect, it } from 'vitest'
import { sessionKey, SESSION_KEY_RE } from './sessionKey'
import { snapshotKey, SNAPSHOT_KEY_RE } from './snapshotKey'

describe('sessionKey (S1)', () => {
  it('round-trips the tabId', () => {
    expect(SESSION_KEY_RE.exec(sessionKey(12))![1]).toBe('12')
  })
  it('session keys and snapshot keys are DISJOINT — no code path can mistake one row for the other', () => {
    expect(SNAPSHOT_KEY_RE.test(sessionKey(7))).toBe(false)
    expect(SESSION_KEY_RE.test(snapshotKey(7, 0))).toBe(false)
  })
})
