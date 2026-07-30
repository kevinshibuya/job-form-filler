/** The ONE text normalization every option/value comparison uses — content
 *  script fills, panel highlight and committed-text verification must agree,
 *  or "saved answer badge but nothing selected" comes back (spec B5d). */
export const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

const MAX_NORMALIZED = 300

/**
 * Canonical form used as the qa_memory lookup key and the learned_mappings key.
 * Accent-stripped so PT labels match whether or not the page uses combining marks.
 */
export function normalizeQuestion(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accent marks
    // A hyphen BETWEEN two alphanumerics joins rather than separates, so the two
    // label spellings "E-mail" and "email" collide on one key. Guarded on both
    // sides: a hyphen used as a separator ("Salary - expected") keeps its
    // surrounding spaces and still collapses below, as do en/em dashes.
    .replace(/([a-z0-9])-(?=[a-z0-9])/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, MAX_NORMALIZED)
    .trim()
}
