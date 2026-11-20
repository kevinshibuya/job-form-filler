import { HandedOverEmailSchema, type HandedOverEmail } from '@jff/shared'
import type { SessionEmailDraft } from './emailDraft'

/**
 * "Open in my mail app" (spec #66, ticket #75): with no Mail account, the
 * Draft goes to the mail app the user already has, through a `mailto:`
 * address. It cannot carry the Resume. What it handed over is kept in the
 * Session, so a later Mark applied records the email as it left and not as
 * the rows read by then.
 */

/** The Session's record of the last handover. */
export const SessionMailHandoverSchema = HandedOverEmailSchema
export type SessionMailHandover = HandedOverEmail

/**
 * Percent-encodes one part of a `mailto:` address as RFC 6068 asks: every
 * byte of the UTF-8 text outside the unreserved set is encoded, so a space is
 * `%20` (a `+` would read back as a plus sign) and `&`, `=`, `?` and `#`
 * cannot end the part early.
 */
const encodePart = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/**
 * The `mailto:` address for an email. The recipient keeps its `@`, which
 * some mail apps do not decode. A line break in the body travels as CRLF,
 * the form RFC 6068 names for it.
 */
export function mailtoAddress(email: Pick<HandedOverEmail, 'applyAddress' | 'subject' | 'body'>): string {
  const to = encodePart(email.applyAddress).replace(/%40/g, '@')
  const body = email.body.replace(/\r?\n/g, '\r\n')
  return `mailto:${to}?subject=${encodePart(email.subject)}&body=${encodePart(body)}`
}

/**
 * The email the mail app would get now, or null when it cannot be handed
 * over: no Apply address, no Draft, or an empty To, subject or body. The body
 * is the Draft's, so AI drafted it; the edited mark and the model are the
 * Draft's own.
 */
export function mailHandoverOf(s: { applyAddress: string | null; emailDraft: SessionEmailDraft | null }): SessionMailHandover | null {
  const d = s.emailDraft
  if (d === null || s.applyAddress === null) return null
  if (s.applyAddress.trim() === '' || d.subject.trim() === '' || d.body.trim() === '') return null
  return {
    applyAddress: s.applyAddress.trim(),
    subject: d.subject,
    body: d.body,
    language: d.language,
    aiDrafted: true,
    edited: d.edited,
    model: d.model,
  }
}
