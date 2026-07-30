/** A3: bilingual confirmation-page vocabulary (spec-fixed, en + pt). Matched
 *  against whitespace-collapsed page text, case-insensitively. */
const CONFIRMATION_PATTERNS: readonly RegExp[] = [
  /thank you for applying/i,
  /application submitted/i,
  /application received/i,
  /obrigado por se candidatar/i,
  /candidatura enviada/i,
  /recebemos sua candidatura/i,
]

/**
 * A3: a submission is SUSPECTED — never recorded silently — when a wizard-step
 * re-scan lost every fillable field, or the new page reads like a confirmation
 * page. The caller turns a true verdict into a dismissible prompt, nothing else.
 */
export function detectSubmission(input: { prevFields: number; newFields: number; pageText: string }): boolean {
  if (input.prevFields > 0 && input.newFields === 0) return true
  const text = input.pageText.replace(/\s+/g, ' ')
  return CONFIRMATION_PATTERNS.some((re) => re.test(text))
}
