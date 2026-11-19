import type { ConnectedAccount, MailAccountDriver, OutgoingEmail, SenderAddressEntry, SignedInAccount, StoredClient } from '../src/mail/account.js'
import type { HostErrorKind } from '@jff/shared'

export declare const FAKE_MAIL_MARKER: 'jffFakeMail'

export declare function mailError(kind: HostErrorKind, message: string): Error & { kind: HostErrorKind }

export interface FakeMailDriver extends MailAccountDriver {
  readonly clientFiles: string[]
  readonly storedClients: StoredClient[]
  readonly senderCalls: SignedInAccount[]
  senders: SenderAddressEntry[]
  sendersFail: Error | null
  readonly cancelled: number
  readonly revoked: string[]
  revokeFails: Error | null
  readonly sent: { account: SignedInAccount; email: OutgoingEmail }[]
  sendFails: Error | null
  onSend: ((account: SignedInAccount, email: OutgoingEmail) => unknown) | null
  returnSignIn(): void
  refuseSignIn(kind?: HostErrorKind, message?: string): void
}

export declare function createFakeMailDriver(opts?: {
  account?: Partial<ConnectedAccount>
  signIn?: 'auto' | 'manual' | 'never'
  refuseClientFile?: string
  revokeFails?: Error | null
  senders?: SenderAddressEntry[]
  sendersFail?: Error | null
  sendFails?: Error | null
  onSend?: (account: SignedInAccount, email: OutgoingEmail) => unknown
}): FakeMailDriver
