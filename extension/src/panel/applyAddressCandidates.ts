import { ADDRESS_CONTEXTS_MAX, APPLY_CANDIDATES_MAX, type AddressContext, type ApplyAddressCandidate, type FoundAddress } from '@jff/shared'

/** Whether a context is a `mailto:` link that sets a subject. */
const setsSubject = (c: AddressContext): boolean => c.kind === 'mailto' && c.subject !== null && c.subject.trim() !== ''

/**
 * The Apply address candidates of a Scan (spec #66), from the address lists
 * the frames reported, given in page order (the top frame first). Addresses
 * are compared without regard to case, and a candidate keeps the spelling it
 * was first seen with. One address found in several places is one candidate
 * with each distinct context in page order, up to `ADDRESS_CONTEXTS_MAX`, and
 * one more: the first `mailto:` context that sets a subject, when none of the
 * kept ones does, so the page's subject survives the cap (#88). The list stops
 * at `APPLY_CANDIDATES_MAX`. The user's own email address, the
 * value of the `email` Known key, is never a candidate.
 */
export function mergeCandidates(
  frames: readonly (readonly FoundAddress[])[],
  ownEmail: string | null,
): ApplyAddressCandidate[] {
  const own = ownEmail?.trim().toLowerCase() ?? ''
  const byAddress = new Map<string, { candidate: ApplyAddressCandidate; seen: Set<string> }>()
  for (const found of frames.flat()) {
    const key = found.address.toLowerCase()
    if (key === own) continue
    let entry = byAddress.get(key)
    if (entry === undefined) {
      if (byAddress.size === APPLY_CANDIDATES_MAX) continue
      entry = { candidate: { address: found.address, contexts: [] }, seen: new Set() }
      byAddress.set(key, entry)
    }
    const context = JSON.stringify(found.context)
    if (entry.seen.has(context)) continue
    if (entry.candidate.contexts.length >= ADDRESS_CONTEXTS_MAX && (!setsSubject(found.context) || entry.candidate.contexts.some(setsSubject))) continue
    entry.seen.add(context)
    entry.candidate.contexts.push(found.context)
  }
  return [...byAddress.values()].map((e) => e.candidate)
}
