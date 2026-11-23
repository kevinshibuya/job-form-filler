/**
 * A question about accommodation needs is the user's to answer: Generation
 * never drafts it (ADR 0014). Whether a Field asks one is decided here, on its
 * label alone, and never by a model, so a failed or mislabelling Mapping cannot
 * open it. The page script reads it to keep such a Field out of the
 * Demographic Fields, and the Native host to give it its own reason.
 */

/** The reason a Needs input Resolution carries when its Field asks about accommodation needs. */
export const ACCOMMODATION_REASON = 'accommodation'

/** The English and Portuguese wordings, matched on folded text. */
const ACCOMMODATION_RE = /accommodat|acomodac|adaptac/

/** Lower case with the accents stripped, so "adaptação" and "adaptacao" fold to the same text. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Whether a Field's label asks about accommodation needs, in English or Portuguese. */
export function asksAboutAccommodation(label: string | null): boolean {
  return ACCOMMODATION_RE.test(fold(label ?? ''))
}
