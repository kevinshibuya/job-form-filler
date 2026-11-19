import { HOST_ERROR_KINDS, type HostErrorKind, type MailKind } from '@jff/shared'

/**
 * A Mail account, as the Native host reaches it (spec #66). The interface has
 * three operations: connect, list Sender addresses and send, and the revoke
 * that Disconnect asks for. The Gmail driver is its only implementation. Send
 * is added by the ticket that builds it.
 */
export interface MailAccountDriver {
  readonly kind: MailKind
  /**
   * Starts the sign-in: the consent address to open, and the sign-in waiting
   * for its return. Given the client file the user dropped, it reads the
   * client from it, and throws a MailError of kind `bad_request` for a file of
   * the wrong type. Given the stored client, it is Reconnect.
   */
  connect(client: string | StoredClient): Promise<PendingConnect>
  /**
   * The addresses the account may send as: its own address first, then each
   * verified "Send mail as" address. `displayName` is the entry's own name,
   * or null when it has none. Throws a MailError of kind `not_authed` when
   * Google refuses the refresh token as invalid, and of another kind for any
   * other failure. The access token it uses stays in this process's memory.
   */
  senderAddresses(account: SignedInAccount): Promise<SenderAddressEntry[]>
  /**
   * Asks the provider to revoke this refresh token and every grant behind it.
   * Throws a MailError when the provider refuses or cannot be reached.
   */
  revoke(refreshToken: string): Promise<void>
}

/** The client a past Connect stored: its id from the database, its secret
 *  from the secret store. */
export interface StoredClient {
  clientId: string
  clientSecret: string
}

/** A connected account with the secrets a call to the provider needs. */
export interface SignedInAccount extends StoredClient {
  address: string
  refreshToken: string
}

/** One address the account may send as, as the provider lists it. */
export interface SenderAddressEntry {
  address: string
  displayName: string | null
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
