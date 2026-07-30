import type { FieldKey } from '@jff/shared'

/**
 * O1: what onboarding demands before scanning unlocks. Outer level = AND (every
 * group must be satisfied); a group = OR of alternatives; an alternative = AND
 * of keys. "salary is now required too" is one added line: `[['salary']]`.
 */
export const REQUIRED_FACTS: ReadonlyArray<ReadonlyArray<ReadonlyArray<FieldKey>>> = [
  [['email']],
  [['phone']],
  [['fullName'], ['firstName', 'lastName']],
]

export type Completeness = 'complete' | 'incomplete' | 'unknown'

const has = (facts: Record<string, string>, key: FieldKey): boolean => (facts[key] ?? '').trim() !== ''

/**
 * O1: tri-state on purpose — facts arrive over the native port, which can die
 * or time out, and an existing user with a complete profile must NEVER be
 * walled into onboarding by a dead host (they would have no working Finish
 * either). `incomplete` requires a SETTLED, SUCCESSFUL load proving it; a load
 * failure or timeout is `unknown`, and the caller falls back to the normal
 * panel plus the host-error banner.
 */
export function profileCompleteness(
  facts: Record<string, string>,
  hasResume: boolean,
  settled: boolean,
): Completeness {
  if (!settled) return 'unknown'
  if (!hasResume) return 'incomplete'
  const groupOk = (group: ReadonlyArray<ReadonlyArray<FieldKey>>): boolean =>
    group.some((alt) => alt.every((k) => has(facts, k)))
  return REQUIRED_FACTS.every(groupOk) ? 'complete' : 'incomplete'
}
