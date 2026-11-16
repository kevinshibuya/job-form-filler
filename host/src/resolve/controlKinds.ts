import { normalizeQuestion, VALUE_TYPE_OF, type FieldKey, type ValueType } from '@jff/shared'

/**
 * Which Controls a Known key may answer, decided by the key's Value type.
 *
 * The rule lists the Controls each Value type answers, never the ones it does
 * not: a Control kind added later takes no Known key until it is listed here.
 * A lone checkbox and a file picker are deliberately absent from every list.
 * A checkbox group takes only the keys `ALSO_ANSWERS` names.
 */
const TEXT_CONTROLS = ['text', 'textarea'] as const
const CHOICE_CONTROLS = ['select', 'combobox', 'radiogroup', 'choice'] as const

const ANSWERS: Readonly<Record<ValueType, ReadonlySet<string>>> = {
  text: new Set(TEXT_CONTROLS),
  link: new Set(TEXT_CONTROLS),
  phone: new Set(TEXT_CONTROLS),
  yes_no: new Set([...CHOICE_CONTROLS, ...TEXT_CONTROLS]),
  place: new Set([...CHOICE_CONTROLS, ...TEXT_CONTROLS]),
}

const CHOICE_SET: ReadonlySet<string> = new Set(CHOICE_CONTROLS)

/** True for a Control that offers Options to choose one from. */
export function isChoiceControl(kind: string): boolean {
  return CHOICE_SET.has(kind)
}

/**
 * Controls one key answers beyond its Value type's list. `pronouns` answers a
 * checkbox group, but only with an Option equal to the stored Value; the
 * Resolution checks that equality, this rule only lets the key through.
 */
const ALSO_ANSWERS: Readonly<Partial<Record<FieldKey, ReadonlySet<string>>>> = {
  pronouns: new Set(['checkboxgroup']),
}

/** True when a Control of this kind can hold the Value of this Known key. */
export function canHold(kind: string, key: FieldKey): boolean {
  return ANSWERS[VALUE_TYPE_OF[key]].has(kind) || (ALSO_ANSWERS[key]?.has(kind) ?? false)
}


// Matched against normalizeQuestion() output: lower case, accents stripped.
const YES_NO_OPTION = /^(yes|no|sim|nao)\b/
const YES_NO_QUESTION = /^(are|is|do|does|did|have|has|can|could|will|would|were|was)\b|^(voce|vc)\s+(mora|reside|vive|esta|possui|tem|pode)\b|^(mora|reside|vive)\b/

/**
 * A Field that asks a yes/no question: its Options are all a yes or a no, or
 * its label opens the way a yes/no question does ("Do you live in…",
 * "Você mora…"). Such a Field may mention a country or a city, but it never
 * asks for one.
 */
export function isYesNoQuestion(label: string, options: readonly string[]): boolean {
  if (options.length > 0 && options.every((o) => YES_NO_OPTION.test(normalizeQuestion(o)))) return true
  return YES_NO_QUESTION.test(normalizeQuestion(label))
}

/** The parts of a Field the rule reads. */
export interface FieldShape {
  kind: string
  label: string | null
  options: readonly string[]
}

/**
 * `canHold` for one Field: its Control must hold the key's Value, and a place
 * never answers a yes/no question, whichever way the key was found.
 */
export function fieldCanHold(f: FieldShape, key: FieldKey): boolean {
  if (!canHold(f.kind, key)) return false
  return VALUE_TYPE_OF[key] !== 'place' || !isYesNoQuestion(f.label ?? '', f.options)
}

/** The key itself when the Field can hold it, else null: a hit on the wrong
 *  Control, or a place on a yes/no question, is not a hit. */
export function keyForField(f: FieldShape, key: FieldKey | null): FieldKey | null {
  return key !== null && fieldCanHold(f, key) ? key : null
}
