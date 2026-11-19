import type { SecretStore } from '../src/mail/secretStore.js'

export declare const FAKE_MAIL_MARKER: 'jffFakeMail'

export interface FakeSecretStore extends SecretStore {
  readonly items: Map<string, string>
}

export declare function createFakeSecretStore(initial?: Record<string, string>): FakeSecretStore
