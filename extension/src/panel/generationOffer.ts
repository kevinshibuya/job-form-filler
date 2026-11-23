import { ACCOMMODATION_REASON, asksAboutAccommodation, type WidgetKind } from '@jff/shared'
import type { Row } from './group'

/** The Controls a Draft can be written into: a text box and a text area. */
const TEXT_CONTROLS: ReadonlySet<WidgetKind> = new Set(['text', 'textarea'])

/**
 * Whether a row offers "Generate with AI", and so whether "Generate all
 * remaining" counts it: a Needs input Field with no Known key on a text
 * Control, whatever label Mapping gave it, unless it asks about accommodation
 * needs (ADR 0014). A choice Control, a checkbox group, a Consent checkbox and
 * a keyed Field are the user's to answer.
 *
 * The accommodation rule reads the label as well as the reason: a missed Fill
 * replaces the row's reason with the page's, and a Reusable Saved answer that
 * matched outright never carried the reason at all.
 */
export function offersGeneration(row: Pick<Row, 'field' | 'resolution'>): boolean {
  const { field, resolution } = row
  return resolution.tier === 'needs_input'
    && resolution.reason !== ACCOMMODATION_REASON
    && !asksAboutAccommodation(field.label)
    && resolution.key === null
    && TEXT_CONTROLS.has(field.kind)
}
