import { rewriteSpacedDashes } from './generate.js'

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

/**
 * The sentences the Draft check flagged that the Draft really contains, each
 * quoted as the Draft has it. `draft` is the Draft as the host returns it,
 * already through `sanitizeDraft`. A flagged sentence gets the same dash
 * rewrite the Draft got, and spacing is ignored on both sides; a sentence the
 * Draft does not contain is dropped, so a warning never quotes words the user
 * cannot find in the Draft.
 */
export function claimsInDraft(draft: string, flagged: readonly string[]): string[] {
  const out: string[] = []
  for (const sentence of flagged) {
    const chars = [...rewriteSpacedDashes(sentence).replace(/\s+/g, '')]
    if (chars.length === 0) continue
    const pattern = new RegExp(chars.map((c) => c.replace(REGEX_SPECIAL, '\\$&')).join('\\s*'))
    const hit = pattern.exec(draft)?.[0]
    if (hit !== undefined && !out.includes(hit)) out.push(hit)
  }
  return out
}
