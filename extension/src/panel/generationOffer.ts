import type { WidgetKind } from '@jff/shared'
import type { Row } from './group'

/** The Controls a Draft can be written into: a text box and a text area. */
const TEXT_CONTROLS: ReadonlySet<WidgetKind> = new Set(['text', 'textarea'])

/**
 * Whether a row offers "Generate with AI", and so whether "Generate all
 * remaining" counts it: a Needs input Prose Field on a text Control, and
 * nothing else. A Personal-fact Field, a Field with no label from Mapping, a
 * choice Control, a checkbox group, a Consent checkbox and a keyed Field are
 * the user's to answer.
 */
export function offersGeneration(row: Pick<Row, 'field' | 'resolution'>): boolean {
  const { field, resolution } = row
  return resolution.tier === 'needs_input'
    && resolution.fieldClass === 'prose'
    && resolution.key === null
    && TEXT_CONTROLS.has(field.kind)
}
