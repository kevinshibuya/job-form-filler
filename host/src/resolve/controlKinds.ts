import { VALUE_TYPE_OF, type FieldKey, type ValueType } from '@jff/shared'

/**
 * Which Controls a Known key may answer, decided by the key's Value type.
 *
 * The rule lists the Controls each Value type answers, never the ones it does
 * not: a Control kind added later takes no Known key until it is listed here.
 * A lone checkbox and a file picker are deliberately absent from every list.
 */
const TEXT_CONTROLS = ['text', 'textarea'] as const
const CHOICE_CONTROLS = ['select', 'combobox', 'radiogroup', 'choice'] as const

const ANSWERS: Readonly<Record<ValueType, ReadonlySet<string>>> = {
  text: new Set(TEXT_CONTROLS),
  link: new Set(TEXT_CONTROLS),
  phone: new Set(TEXT_CONTROLS),
  yes_no: new Set([...CHOICE_CONTROLS, ...TEXT_CONTROLS]),
  place: new Set(),
}

/** True when a Control of this kind can hold the Value of this Known key. */
export function canHold(kind: string, key: FieldKey): boolean {
  return ANSWERS[VALUE_TYPE_OF[key]].has(kind)
}

/** The key itself when the Control can hold it, else null: a hit on the wrong
 *  Control is not a hit. */
export function keyFor(kind: string, key: FieldKey | null): FieldKey | null {
  return key !== null && canHold(kind, key) ? key : null
}
