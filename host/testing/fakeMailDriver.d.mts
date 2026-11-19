import type { ConnectedAccount, MailAccountDriver } from '../src/mail/account.js'
import type { HostErrorKind } from '@jff/shared'

export declare const FAKE_MAIL_MARKER: 'jffFakeMail'

export declare function mailError(kind: HostErrorKind, message: string): Error & { kind: HostErrorKind }

export interface FakeMailDriver extends MailAccountDriver {
  readonly clientFiles: string[]
  readonly cancelled: number
  returnSignIn(): void
  refuseSignIn(kind?: HostErrorKind, message?: string): void
}

export declare function createFakeMailDriver(opts?: {
  account?: Partial<ConnectedAccount>
  signIn?: 'auto' | 'manual' | 'never'
  refuseClientFile?: string
}): FakeMailDriver
