/** The ONE text normalization every option/value comparison uses — content
 *  script fills, panel highlight and committed-text verification must agree,
 *  or "saved answer badge but nothing selected" comes back (spec B5d). */
export const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
