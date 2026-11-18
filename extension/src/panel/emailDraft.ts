import { z } from 'zod'
import {
  EmailDraftResultSchema,
  type ApplyAddressCandidate, type EmailDraftParams, type EmailDraftResult, type HostErrorKind,
} from '@jff/shared'
import type { HostPort } from './port'

/**
 * The Application email, the Side panel's half (spec #66). The Native host
 * drafts it; the panel says which subject the page set, keeps the Draft in
 * the Session with what the user did to it, and shows it for Review.
 */

/**
 * The Draft as the Session holds it: the reply, whether the user edited the
 * body since, and the subject the page set when it was asked for, or null.
 */
export const SessionEmailDraftSchema = EmailDraftResultSchema.extend({
  edited: z.boolean(),
  pageSubject: z.string().nullable(),
})
export type SessionEmailDraft = z.infer<typeof SessionEmailDraftSchema>

/** What the Draft shows while there is none in the Session: out, or failed with its reason. */
export type EmailDraftUi = { kind: 'drafting' } | { kind: 'failed'; reason: string }

export type EmailDraftOutcome =
  | { kind: 'drafted'; draft: EmailDraftResult }
  | { kind: 'failed'; error: { kind: HostErrorKind; message: string } }

/**
 * The subject the page sets for an address: the first non-empty `subject` of
 * a `mailto:` link to it, in page order. Null when no link to it sets one, as
 * for a typed address the page never shows.
 */
export function pageSubjectFor(candidates: readonly ApplyAddressCandidate[], address: string): string | null {
  const wanted = address.toLowerCase()
  for (const c of candidates) {
    if (c.address.toLowerCase() !== wanted) continue
    for (const ctx of c.contexts) {
      if (ctx.kind === 'mailto' && ctx.subject !== null && ctx.subject.trim() !== '') return ctx.subject
    }
  }
  return null
}

/** The Session can be drafted for: an Apply address, Job posting text, and no Draft yet. */
export const emailDraftOwed = (s: { applyAddress: string | null; jobText: string; emailDraft: SessionEmailDraft | null }): boolean =>
  s.applyAddress !== null && s.emailDraft === null && s.jobText.trim() !== ''

/** The request for a Session's Application email. */
export function emailDraftParams(
  s: { applyAddress: string | null; applyCandidates: ApplyAddressCandidate[]; company: string; jobText: string },
  title: string, cvText: string | null,
): EmailDraftParams {
  const company = s.company.trim()
  return {
    jobText: s.jobText,
    company: company === '' ? null : company,
    title: title.trim() === '' ? null : title.trim(),
    pageSubject: s.applyAddress === null ? null : pageSubjectFor(s.applyCandidates, s.applyAddress),
    ...(cvText === null ? {} : { cvText }),
  }
}

/** Ask the Native host for the Draft. Never throws: a lost or malformed reply is a failed Draft. */
export async function requestEmailDraft(port: HostPort | null | undefined, params: EmailDraftParams): Promise<EmailDraftOutcome> {
  if (port === null || port === undefined) return { kind: 'failed', error: { kind: 'unreachable', message: 'no host' } }
  try {
    const r = await port.request('email.draft', params)
    if (!r.ok) return { kind: 'failed', error: r.error }
    const parsed = EmailDraftResultSchema.safeParse(r.result)
    if (!parsed.success) return { kind: 'failed', error: { kind: 'invalid_output', message: 'the Draft came back malformed' } }
    return { kind: 'drafted', draft: parsed.data }
  } catch (e) {
    return { kind: 'failed', error: { kind: 'unreachable', message: e instanceof Error ? e.message : String(e) } }
  }
}
