import { OPTIONS_READ, OptionPickResultSchema, isCheckboxGroup, type EnumField, type FieldHandle, type Resolution } from '@jff/shared'
import { refOf } from './group'
import type { HostPort } from './port'

/** The reason on a row whose Option the model picked: it is Proposed. */
export const OPTION_PICK = 'option-pick'
/** The reason on a row whose model pick failed: it is Needs input with the picker. */
export const OPTION_PICK_FAILED = 'option-pick-failed'

/** The one Fill miss a pick can help with: the page offered Options and none matched. */
const NO_MATCH = 'no-matching-option'

/** What an `option.pick` request carries, and the Field it is for. */
export interface PickRequest {
  handle: FieldHandle
  label: string
  value: string
  options: string[]
}

export type PickOutcome =
  | { kind: 'picked'; option: string }
  | { kind: 'none' }
  | { kind: 'failed'; message: string }

/**
 * The model pick a Fill miss owes (ADR 0008), or null when it owes none.
 *
 * One is owed only when the page offered Options and none matched, the Value
 * sent was the Resolution's own, and that Value is an identified stored one: a
 * Known key's Value or a derived answer (the Resolution names its key), or a
 * Saved answer (it names the answer). A Value the user typed, an Option the
 * model already picked and a checkbox group's set owe none. The Options are
 * the ones the Fill read, else the ones the Field already had.
 */
export function pickOwed(
  resolution: Resolution,
  field: Pick<EnumField, 'label' | 'kind' | 'options'> | undefined,
  miss: { reason: string; options?: string[] },
  sent: string | null = resolution.value,
): PickRequest | null {
  if (resolution.standsFor !== undefined) return null
  if (resolution.value === null) return readPickOwed(resolution, field, miss)
  if (miss.reason !== NO_MATCH) return null
  const value = resolution.value
  if (value === null || value.trim() === '' || sent !== value) return null
  if (resolution.source === 'page' || (resolution.key === null && resolution.answerId === null)) return null
  if (field !== undefined && isCheckboxGroup(field)) return null
  const options = miss.options !== undefined && miss.options.length > 0 ? miss.options : field?.options ?? []
  if (options.length === 0) return null
  return { handle: resolution.handle, label: field?.label ?? '', value, options }
}

/**
 * The pick a read owes (ticket #34): a row with no Value whose stored Value is
 * identified (Resolution.identifiedValue) was sent to the Fill with no Value,
 * and the page reported the Control's Options. The pick is asked with the
 * identified Value over exactly the Options read; with none read, none is
 * owed. A checkbox group owes one too: the pick is one of its Options.
 */
function readPickOwed(
  resolution: Resolution, field: Pick<EnumField, 'label'> | undefined, read: { reason: string; options?: string[] },
): PickRequest | null {
  const value = resolution.identifiedValue
  if (value === undefined || read.reason !== OPTIONS_READ) return null
  const options = read.options ?? []
  if (options.length === 0) return null
  return { handle: resolution.handle, label: field?.label ?? '', value, options }
}

/** Ask the host for the pick. Never throws: a lost or malformed reply is a failed pick. */
export async function requestPick(port: HostPort | null | undefined, req: PickRequest): Promise<PickOutcome> {
  if (port === null || port === undefined) return { kind: 'failed', message: 'no host' }
  try {
    const r = await port.request('option.pick', { label: req.label, value: req.value, options: req.options })
    if (!r.ok) return { kind: 'failed', message: r.error.message }
    const parsed = OptionPickResultSchema.safeParse(r.result)
    if (!parsed.success) return { kind: 'failed', message: 'the pick came back malformed' }
    const { position } = parsed.data
    const option = position === null ? undefined : req.options[position]
    return option === undefined ? { kind: 'none' } : { kind: 'picked', option }
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * A pick's outcome on the row it was asked for. A pick makes the row Proposed
 * with the Option, and the row keeps the stored Value it stands for; the
 * Value's candidate words, phone parts and city parts belong to the stored
 * Value and do not travel with the Option. None leaves the row as the miss left it. A
 * failure says so on the row.
 *
 * The outcome lands only on the row the miss left: same Scan, still Needs
 * input with the miss's reason and Value, and nothing the user typed or put on
 * the page since. After a read (ticket #34) that row is still Needs input with
 * no Value and the identified Value the pick was asked with.
 */
export function landPick<S extends { epoch: number; resolutions: Resolution[]; edits: Record<string, string>; filledRefs: string[] }>(
  s: S, req: PickRequest, outcome: PickOutcome,
): S {
  if (outcome.kind === 'none' || s.epoch !== req.handle.epoch) return s
  const ref = refOf(req.handle)
  if (s.edits[ref] !== undefined || s.filledRefs.includes(ref)) return s
  const at = s.resolutions.findIndex((r) => refOf(r.handle) === ref)
  const current = s.resolutions[at]
  if (current === undefined || current.tier !== 'needs_input') return s
  const asLeft = current.value === null
    ? current.identifiedValue === req.value
    : current.reason === NO_MATCH && current.value === req.value
  if (!asLeft) return s
  const resolutions = [...s.resolutions]
  if (outcome.kind === 'failed') {
    resolutions[at] = { ...current, reason: OPTION_PICK_FAILED }
  } else {
    const { candidates: _candidates, phone: _phone, city: _city, identifiedValue: _identified, ...rest } = current
    resolutions[at] = { ...rest, tier: 'proposed', value: outcome.option, reason: OPTION_PICK, standsFor: req.value }
  }
  return { ...s, resolutions }
}
