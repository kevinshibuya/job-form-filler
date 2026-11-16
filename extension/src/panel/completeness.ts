import { storedValue, type FieldKey } from '@jff/shared'

/**
 * O1: what onboarding demands before scanning unlocks. Outer level = AND (every
 * group must be satisfied); a group = OR of alternatives; an alternative = AND
 * of keys. "salary is now required too" is one added line: `[['salary']]`.
 */
export const REQUIRED_FACTS: ReadonlyArray<ReadonlyArray<ReadonlyArray<FieldKey>>> = [
  [['email']],
  [['phone']],
  [['fullName'], ['firstName', 'lastName']],
  [['country']],
]

export type Completeness = 'complete' | 'incomplete' | 'unknown'

/** A fact counts only as a Value: a phone still in old text does not. */
const has = (facts: Record<string, string>, key: FieldKey): boolean =>
  (facts[key] ?? '').trim() !== '' && storedValue(key, facts[key]) !== null

const groupOk = (facts: Record<string, string>) => (group: ReadonlyArray<ReadonlyArray<FieldKey>>): boolean =>
  group.some((alt) => alt.every((k) => has(facts, k)))

/** How the onboarding form names a missing group: by its first key. */
const GROUP_NAME: Partial<Record<FieldKey, string>> = { fullName: 'name' }

/**
 * What still stands between these facts and a complete Profile, in the order
 * the form asks for it: `resume`, then each unsatisfied group by name (`email`,
 * `phone`, `name`, `country`). A phone in old text is missing.
 */
export function missingFacts(facts: Record<string, string>, hasResume: boolean): string[] {
  const groups = REQUIRED_FACTS.filter((g) => !groupOk(facts)(g)).map((g) => {
    const first = g[0]![0]!
    return GROUP_NAME[first] ?? first
  })
  return [...(hasResume ? [] : ['resume']), ...groups]
}

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
  return REQUIRED_FACTS.every(groupOk(facts)) ? 'complete' : 'incomplete'
}
