import { norm, type EnumField, type LearnWordingParams, type Resolution } from '@jff/shared'
import type { HostPort } from './port'

/** Sources whose row stands for something other than a Known key's Value. */
const NOT_A_KEY_VALUE: ReadonlySet<Resolution['source']> = new Set(['page', 'saved_answer', 'llm_reuse'])

/**
 * The Learned wording (ticket #35) an Option the page just took teaches, or
 * null when it teaches none.
 *
 * One is learned when the user accepts a model-picked Option (`accept`, on a
 * row that names the stored Value it stands for), or picks an Option and fills
 * it after a miss (`fill`, on a Needs input row). The row must be answered
 * from a Known key: it names a key and no Saved answer, and its Value is not
 * one the page already held. The Value learned for is the stored Value the
 * Option stood for: the one the model was asked with, the one whose Fill
 * missed, or the one identified for a read. The wording is the page's Option
 * itself, one of the Options known for the Field, and never one equal to that
 * Value, which the rule table matches anyway.
 */
export function wordingToLearn(
  resolution: Resolution,
  options: readonly string[],
  committed: string,
  how: 'accept' | 'fill',
): LearnWordingParams | null {
  const { key } = resolution
  if (key === null || resolution.answerId !== null || NOT_A_KEY_VALUE.has(resolution.source)) return null
  if (how === 'accept' && resolution.standsFor === undefined) return null
  // An Accept teaches only the model's own pick. A user who changed it before
  // accepting answered this role differently; that is not a wording of the
  // stored Value, and learning it would auto-fill the change everywhere.
  if (how === 'accept' && norm(committed) !== norm(resolution.value ?? '')) return null
  const value = resolution.standsFor ?? resolution.value ?? resolution.identifiedValue
  if (value === undefined || value === null || value.trim() === '') return null
  if (committed.includes('\n')) return null
  const wording = options.find((o) => norm(o) === norm(committed))
  if (wording === undefined || norm(wording) === '' || norm(wording) === norm(value)) return null
  return { key, value, wording }
}

/** The Options known for a Field: those the Fill just read, else those it had. */
export const knownOptions = (field: Pick<EnumField, 'options'>, read: string[] | undefined): string[] =>
  read !== undefined && read.length > 0 ? read : field.options

/** Send a Learned wording to the host. Fire and forget: a lost one only means the next Fill asks again. */
export function sendLearnedWording(port: HostPort | null | undefined, learned: LearnWordingParams | null): void {
  if (learned === null || port === null || port === undefined) return
  void port.request('wording.learn', learned).catch(() => { /* a lost wording is asked again next time */ })
}
