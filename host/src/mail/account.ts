import { HOST_ERROR_KINDS, type HostErrorKind, type MailKind } from '@jff/shared'

/**
 * A Mail account, as the Native host reaches it (spec #66). The interface has
 * three operations: connect, list Sender addresses and send. The Gmail driver
 * is its only implementation. Connect is built here; the Sender addresses and
 * send are added by the tickets that build them.
 */
export interface MailAccountDriver {
  readonly kind: MailKind
  /**
   * Reads the client file the user dropped and starts the sign-in: the
   * consent address to open, and the sign-in waiting for its return. Throws a
   * MailError of kind `bad_request` for a client file of the wrong type.
   */
  connect(clientFile: string): Promise<PendingConnect>
}

/** A sign-in in progress. */
export interface PendingConnect {
  /** Google's consent page, for the settings page to open in a tab. */
  consentUrl: string
  /** Settles once the sign-in returns and its code is exchanged. Rejects with
   *  a MailError on a refused return, a refused exchange or `cancel`. */
  result: Promise<ConnectedAccount>
  /** Stops waiting: the listener closes and `result` rejects. */
  cancel(): void
}

/** What a finished sign-in yields. The two secrets go to the secret store only. */
export interface ConnectedAccount {
  address: string
  clientId: string
  clientSecret: string
  refreshToken: string
}

/**
 * A Mail account failure, with the error kind the response carries. Matched by
 * its name and kind, so a test driver written as a plain module (host/testing)
 * can throw one without importing this file.
 */
export class MailError extends Error {
  override readonly name = 'MailError'
  constructor(readonly kind: HostErrorKind, message: string) {
    super(message)
  }
}

export function asMailError(e: unknown): { kind: HostErrorKind; message: string } | null {
  if (!(e instanceof Error) || e.name !== 'MailError') return null
  const kind = (e as { kind?: unknown }).kind
  return typeof kind === 'string' && (HOST_ERROR_KINDS as readonly string[]).includes(kind)
    ? { kind: kind as HostErrorKind, message: e.message }
    : null
}
