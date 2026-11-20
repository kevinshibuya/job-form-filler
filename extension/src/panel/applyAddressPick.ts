import {
  APPLY_PICK_JOB_TEXT_MAX, ApplyAddressPickResultSchema,
  type ApplyAddressCandidate, type ApplyAddressPickParams, type HostErrorKind,
} from '@jff/shared'
import type { HostPort } from './port'

/**
 * The Apply address pick, the Side panel's half (spec #66, ADR 0008). The
 * Native host's model answers a position among the candidates the request
 * carried, or none. The panel turns the position back into one of those
 * candidates and refuses one outside the list, so an address only ever comes
 * from the page.
 */

export type AddressPickOutcome =
  | { kind: 'picked'; address: string }
  | { kind: 'none' }
  | { kind: 'failed'; error: { kind: HostErrorKind; message: string } }

/** What the pick shows the email flow: out, ended with none, or failed with its reason. */
export type AddressPickUi = { kind: 'picking' } | { kind: 'none' } | { kind: 'failed'; reason: string }

/** The request for a Session's candidates: the title and Company when known,
 *  and the start of the Job posting text. */
export function addressPickParams(
  s: { applyCandidates: ApplyAddressCandidate[]; company: string; jobText: string }, title: string,
): ApplyAddressPickParams {
  const company = s.company.trim()
  return {
    candidates: s.applyCandidates,
    title: title.trim() === '' ? null : title.trim(),
    company: company === '' ? null : company,
    jobText: s.jobText.slice(0, APPLY_PICK_JOB_TEXT_MAX),
  }
}

/** Ask the Native host for the pick. Never throws: a lost or malformed reply is a failed pick. */
export async function requestAddressPick(port: HostPort | null | undefined, params: ApplyAddressPickParams): Promise<AddressPickOutcome> {
  if (port === null || port === undefined) return { kind: 'failed', error: { kind: 'unreachable', message: 'no host' } }
  try {
    const r = await port.request('applyAddress.pick', params)
    if (!r.ok) return { kind: 'failed', error: r.error }
    const parsed = ApplyAddressPickResultSchema.safeParse(r.result)
    if (!parsed.success) return { kind: 'failed', error: { kind: 'invalid_output', message: 'the pick came back malformed' } }
    const { position } = parsed.data
    const picked = position === null ? undefined : params.candidates[position]
    return picked === undefined ? { kind: 'none' } : { kind: 'picked', address: picked.address }
  } catch (e) {
    return { kind: 'failed', error: { kind: 'unreachable', message: e instanceof Error ? e.message : String(e) } }
  }
}
