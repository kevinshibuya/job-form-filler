import type Database from 'better-sqlite3'
import type { MailConnectStartResult, MailDisconnectResult, MailSendersResult, MailStatus } from '@jff/shared'
import { deleteMailAccount, getMailAccount, getProfile, saveMailAccount, setMailAccountState } from '../db/repos.js'
import { profileName } from '../llm/applicationEmail.js'
import { asMailError, MailError, type MailAccountDriver, type PendingConnect, type StoredClient } from './account.js'
import { secretAccount, type SecretStore } from './secretStore.js'

/**
 * How long `mail.connect.finish` waits for the sign-in to come back: long
 * enough to pass Google's unverified-app screen and its permissions page,
 * and well under the Side panel port's ten-minute deadline.
 */
export const CONNECT_TIMEOUT_MS = 5 * 60_000

export interface MailRequestDeps {
  driver: MailAccountDriver
  secrets: SecretStore
  /** Resolves once `ms` have passed. Tests pass their own clock. */
  timeout?: (ms: number) => Promise<void>
  now?: () => Date
}

/** The Mail account requests (spec #66), and the sign-in this Native host
 *  process is waiting for, which lives between `start` and `finish`. */
export interface MailRequests {
  status(db: Database.Database): MailStatus
  /** With no client file, Reconnect: the sign-in with the stored client. */
  connectStart(db: Database.Database, clientFile?: string): Promise<MailConnectStartResult>
  connectFinish(db: Database.Database): Promise<MailStatus>
  disconnect(db: Database.Database): Promise<MailDisconnectResult>
  senders(db: Database.Database): Promise<MailSendersResult>
}

const NEEDS_RECONNECT =
  'The sign-in to this Mail account has expired or was revoked. Click Reconnect to sign in again. Your Draft is kept.'

const NOTHING_TO_RECONNECT =
  'There is no stored client to reconnect with. Drop the client file in the settings page and click Connect.'

/** What Disconnect answers when Google did not revoke the token. The account
 *  and its secrets are gone all the same. */
const notRevoked = (why: string): string =>
  `The sign-in could not be revoked at Google (${why}). The tool has forgotten the account and its secrets. ` +
  'To remove its access at Google too, open your Google Account, then Security, then Third-party connections.'


const realTimeout = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms).unref() })

export function createMailRequests(deps: MailRequestDeps): MailRequests {
  const timeout = deps.timeout ?? realTimeout
  const now = deps.now ?? (() => new Date())
  let pending: PendingConnect | null = null

  const status = (db: Database.Database): MailStatus => {
    const row = getMailAccount(db)
    return row === null ? { state: 'none' } : { state: row.state, kind: row.kind, address: row.address, connectedAt: row.connectedAt }
  }

  return {
    status,

    async connectStart(db, clientFile) {
      // Reconnect reads the stored client before anything stops: a refusal
      // here leaves a sign-in in progress as it was.
      let client: string | StoredClient
      if (clientFile !== undefined) client = clientFile
      else {
        const row = getMailAccount(db)
        const secret = row === null ? null : await deps.secrets.get(secretAccount(row.kind, row.address, 'client_secret'))
        if (row === null || secret === null) throw new MailError('bad_request', NOTHING_TO_RECONNECT)
        client = { clientId: row.clientId, clientSecret: secret }
      }
      // One sign-in at a time: a new Connect stops the one before it.
      pending?.cancel()
      pending = null
      const started = await deps.driver.connect(client)
      // A refused return before `finish` waits on it must not go unhandled.
      started.result.catch(() => {})
      pending = started
      return { consentUrl: started.consentUrl }
    },

    async connectFinish(db) {
      const signIn = pending
      pending = null
      if (signIn === null) throw new MailError('bad_request', 'No sign-in is waiting. Click Connect to start one.')
      const account = await Promise.race([signIn.result, timeout(CONNECT_TIMEOUT_MS).then(() => null)])
      if (account === null) {
        signIn.cancel()
        throw new MailError('timeout', `The sign-in did not come back within ${CONNECT_TIMEOUT_MS / 60_000} minutes. Nothing was connected. Click Connect to try again.`)
      }
      const kind = deps.driver.kind
      // A different account replaces the one before it, and its secrets go too.
      const before = getMailAccount(db)
      if (before !== null && before.address !== account.address) {
        await deps.secrets.delete(secretAccount(before.kind, before.address, 'refresh_token'))
        await deps.secrets.delete(secretAccount(before.kind, before.address, 'client_secret'))
      }
      // The secrets first: a row with no secrets behind it would claim a
      // connection that cannot send.
      await deps.secrets.set(secretAccount(kind, account.address, 'refresh_token'), account.refreshToken)
      await deps.secrets.set(secretAccount(kind, account.address, 'client_secret'), account.clientSecret)
      saveMailAccount(db, { kind, address: account.address, clientId: account.clientId, connectedAt: now().toISOString() })
      return status(db)
    },

    // The Sender addresses. Only Google refusing the sign-in as invalid
    // (`not_authed` from the driver) marks the account "needs reconnect": a
    // network failure or a Gmail error leaves it connected.
    async senders(db) {
      const row = getMailAccount(db)
      if (row === null) throw new MailError('bad_request', 'No Mail account is connected. Connect one in the settings page.')
      if (row.state === 'needs_reconnect') throw new MailError('not_authed', NEEDS_RECONNECT)
      const [refreshToken, clientSecret] = await Promise.all([
        deps.secrets.get(secretAccount(row.kind, row.address, 'refresh_token')),
        deps.secrets.get(secretAccount(row.kind, row.address, 'client_secret')),
      ])
      if (refreshToken === null || clientSecret === null) {
        setMailAccountState(db, 'needs_reconnect')
        throw new MailError('not_authed', NEEDS_RECONNECT)
      }
      let list
      try {
        list = await deps.driver.senderAddresses({ address: row.address, clientId: row.clientId, clientSecret, refreshToken })
      } catch (e) {
        if (asMailError(e)?.kind === 'not_authed') setMailAccountState(db, 'needs_reconnect')
        throw e
      }
      const name = profileName(getProfile(db)) ?? ''
      return {
        address: row.address,
        senders: list.map((s) => ({ address: s.address, displayName: s.displayName ?? name })),
        lastUsed: row.lastSenderAddress,
      }
    },

    async disconnect(db) {
      const row = getMailAccount(db)
      if (row === null) return { revoked: false, warning: null }
      const refresh = secretAccount(row.kind, row.address, 'refresh_token')
      // Revoking is a courtesy to the user's Google account. Whatever Google
      // answers, or fails to, the secrets and the row go below.
      let warning: string | null = null
      try {
        const token = await deps.secrets.get(refresh)
        if (token === null) warning = notRevoked('no refresh token was stored')
        else await deps.driver.revoke(token)
      } catch (e) {
        warning = notRevoked(asMailError(e)?.message ?? (e instanceof Error ? e.message : String(e)))
      }
      // The secrets before the row: a failed delete leaves the row, so
      // Disconnect can run again, and no secret outlives its account.
      await deps.secrets.delete(refresh)
      await deps.secrets.delete(secretAccount(row.kind, row.address, 'client_secret'))
      deleteMailAccount(db)
      return { revoked: warning === null, warning }
    },
  }
}
