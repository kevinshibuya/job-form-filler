import type Database from 'better-sqlite3'
import type {
  MailConnectStartResult, MailDisconnectResult, MailSendArrivedParams, MailSendArrivedResult, MailSendParams, MailSendResult,
  MailSendSent, MailSendersResult, MailStatus,
} from '@jff/shared'
import {
  abandonSendAttempt, deleteMailAccount, findSendAttempt, getMailAccount, getProfile, getSendAttempt, getSentAnswer, recordArrivedEmail,
  recordSentEmail, saveMailAccount, setMailAccountState, setSendAttemptState, startSendAttempt, type MailAccountRow, type SendAttempt,
} from '../db/repos.js'
import { profileName } from '../llm/applicationEmail.js'
import { log } from '../log.js'
import {
  asMailError, MailError, type MailAccountDriver, type PendingConnect, type SenderAddressEntry, type SentEmail, type SignedInAccount,
  type StoredClient,
} from './account.js'
import { secretAccount, type SecretStore } from './secretStore.js'

/**
 * How long `mail.connect.finish` waits for the sign-in to come back: long
 * enough to pass Google's unverified-app screen and its permissions page,
 * and well under the Side panel port's ten-minute deadline.
 */
export const CONNECT_TIMEOUT_MS = 5 * 60_000

/**
 * How long `mail.send` waits for the driver's answer before it answers
 * "outcome unknown" (ticket #83): past the driver's own call deadlines, and
 * well under the Side panel port's ten-minute deadline. The driver's call
 * goes on; an answer that comes later is still recorded.
 */
export const SEND_TIMEOUT_MS = 2 * 60_000

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
  /** One Send: the attempt first, then the Sender address check, the
   *  driver's send, and on success the record in one transaction. */
  send(db: Database.Database, requestId: string, params: MailSendParams): Promise<MailSendResult>
  /** "It arrived": the user settles an outcome the tool could not know. */
  arrived(db: Database.Database, params: MailSendArrivedParams): MailSendArrivedResult
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


const NO_ACCOUNT = 'No Mail account is connected. Connect one in the settings page.'

const IN_FLIGHT =
  'A Send of an Application email to this address for this Job posting is already under way. Nothing was sent again.'

const SAME_REQUEST = 'This Send was already made once. Nothing was sent again. Click Send to make a new one.'

/** A Send to a Job posting and Apply address that already went out, without
 *  the user's choice to send again. */
const alreadySent = (address: string): string =>
  `An Application email to ${address} for this Job posting was already sent. Nothing was sent again.`

const notArrived = (state: string): string =>
  `This Send was already settled as ${state}. Nothing was marked. Click Send to make a new one.`

/** The email left Gmail, and recording it failed. The attempt stays started,
 *  so no click sends it a second time. */
const sentNotRecorded = (why: string): string =>
  `The Application email was sent, but recording it failed (${why}). Check your Sent folder; ` +
  'the Job posting is not marked applied yet, and Send stays locked for this address so it does not go out twice.'

const unknown = (attemptRequestId: string): MailSendResult => ({ outcome: 'unknown', attemptRequestId })

/**
 * Whether a failure of the driver's send leaves its outcome unknown (ticket
 * #83). Only a Mail failure the provider or the driver states is definite;
 * a `timeout` (the call began and no answer came back) and anything that is
 * not a Mail failure at all are not failures, so the attempt stays started.
 */
function outcomeUnknown(e: unknown): boolean {
  const mail = asMailError(e)
  return mail === null || mail.kind === 'timeout'
}

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

  /** The account with its secrets, or a MailError. A missing secret, or a
   *  sign-in Google refuses, marks the account "needs reconnect". */
  async function signedIn(db: Database.Database): Promise<{ row: MailAccountRow; account: SignedInAccount }> {
    const row = getMailAccount(db)
    if (row === null) throw new MailError('bad_request', NO_ACCOUNT)
    if (row.state === 'needs_reconnect') throw new MailError('not_authed', NEEDS_RECONNECT)
    const [refreshToken, clientSecret] = await Promise.all([
      deps.secrets.get(secretAccount(row.kind, row.address, 'refresh_token')),
      deps.secrets.get(secretAccount(row.kind, row.address, 'client_secret')),
    ])
    if (refreshToken === null || clientSecret === null) {
      setMailAccountState(db, 'needs_reconnect')
      throw new MailError('not_authed', NEEDS_RECONNECT)
    }
    return { row, account: { address: row.address, clientId: row.clientId, clientSecret, refreshToken } }
  }

  /** A call to the provider; one Google refuses as a dead sign-in marks the
   *  account "needs reconnect". */
  async function withSignIn<T>(db: Database.Database, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (e) {
      if (asMailError(e)?.kind === 'not_authed') setMailAccountState(db, 'needs_reconnect')
      throw e
    }
  }

  /**
   * What a Send finds before it starts its own attempt, in one immediate
   * transaction, so no other Native host process slips in between: its own
   * request id seen before, a started attempt for the Job posting and Apply
   * address, or a sent one the user did not choose to send again. Null
   * when the attempt is now started and the Send goes on.
   */
  function begin(db: Database.Database, requestId: string, p: MailSendParams): MailSendResult | null {
    return db.transaction((): MailSendResult | null => {
      const own = getSendAttempt(db, requestId)
      if (own !== null) return answerOf(db, own)
      if (p.abandonAttempt !== null) abandonSendAttempt(db, p.abandonAttempt)
      const out = findSendAttempt(db, p.url, p.applyAddress, 'started')
      if (out !== null) return unknown(out.requestId)
      if (!p.resend && findSendAttempt(db, p.url, p.applyAddress, 'sent') !== null) {
        throw new MailError('bad_request', alreadySent(p.applyAddress.trim().toLowerCase()))
      }
      const started = startSendAttempt(db, { requestId, url: p.url, applyAddress: p.applyAddress })
      if (!started.ok) throw new MailError('bad_request', started.why === 'in_flight' ? IN_FLIGHT : SAME_REQUEST)
      return null
    }).immediate()
  }

  /** The answer to a request id already recorded: a sent attempt answers its
   *  success again, a started one "outcome unknown", any other is refused. */
  function answerOf(db: Database.Database, a: SendAttempt): MailSendResult {
    if (a.state === 'started') return unknown(a.requestId)
    const answer = a.state === 'sent' ? getSentAnswer(db, a.requestId) : null
    if (answer === null) throw new MailError('bad_request', SAME_REQUEST)
    return { outcome: 'sent', ...answer }
  }

  /** The email left Gmail: the record in one transaction. */
  function record(db: Database.Database, requestId: string, p: MailSendParams, senderAddress: string, sent: SentEmail): MailSendSent {
    try {
      const answer = recordSentEmail(db, {
        requestId, url: p.url, company: p.company, jobTitle: p.jobTitle,
        email: {
          applyAddress: p.applyAddress.trim(), senderAddress, subject: p.subject, body: p.body,
          attachmentNames: [p.resume.name.trim()], language: p.language,
          gmailMessageId: sent.messageId, gmailThreadId: sent.threadId, route: 'tool',
          aiDrafted: p.aiDrafted, edited: p.edited, model: p.model,
        },
      })
      return { outcome: 'sent', ...answer }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      log('error', 'sent, not recorded', { requestId, message: why })
      throw new MailError('db', sentNotRecorded(why))
    }
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
      const { row, account } = await signedIn(db)
      const list = await withSignIn(db, () => deps.driver.senderAddresses(account))
      const name = profileName(getProfile(db)) ?? ''
      return {
        address: row.address,
        senders: list.map((s) => ({ address: s.address, displayName: s.displayName ?? name })),
        lastUsed: row.lastSenderAddress,
      }
    },

    // Send (spec #66). The attempt is recorded before anything else can
    // fail, and before Gmail is called: its insert is the lock. A failure
    // before the driver's call, and one the provider states, is definite:
    // the attempt becomes failed and the user may click again. An outcome
    // the tool cannot know leaves it started (ticket #83): nothing settles
    // that doubt by sending but the user's "Send again". The Resume's bytes
    // live in this call alone: no log line, row or reply holds them.
    async send(db, requestId, p) {
      const begun = begin(db, requestId, p)
      if (begun !== null) return begun

      let account: SignedInAccount
      let sender: SenderAddressEntry
      try {
        account = (await signedIn(db)).account
        // The Native host reads the list itself: the panel's choice is not trusted.
        const list = await withSignIn(db, () => deps.driver.senderAddresses(account))
        const wanted = p.senderAddress.trim().toLowerCase()
        const found = list.find((s) => s.address.toLowerCase() === wanted)
        if (found === undefined) {
          throw new MailError('bad_request',
            `${p.senderAddress.trim()} is not an address this Mail account may send as. Pick a Sender address from the list. Nothing was sent.`)
        }
        sender = { address: found.address, displayName: found.displayName ?? profileName(getProfile(db)) ?? '' }
      } catch (e) {
        setSendAttemptState(db, requestId, 'failed')
        throw e
      }

      // From here the call to Gmail has begun. The driver's answer settles
      // the attempt whenever it comes, even after the deadline below.
      const delivery: Promise<MailSendResult> = withSignIn(db, () => deps.driver.send(account, {
        from: { address: sender.address, displayName: sender.displayName ?? '' },
        to: p.applyAddress.trim(),
        subject: p.subject,
        body: p.body,
        attachment: { name: p.resume.name.trim(), mimeType: p.resume.mimeType, data: Buffer.from(p.resume.dataBase64, 'base64') },
      })).then(
        (sent) => record(db, requestId, p, sender.address, sent),
        (e: unknown) => {
          if (outcomeUnknown(e)) {
            log('warn', 'send outcome unknown', { requestId, message: e instanceof Error ? e.message : String(e) })
            return unknown(requestId)
          }
          setSendAttemptState(db, requestId, 'failed')
          throw e
        },
      )
      // An answer that lands after the deadline has nobody to throw to.
      delivery.catch(() => {})
      return Promise.race([
        delivery,
        timeout(SEND_TIMEOUT_MS).then(() => {
          log('warn', 'send outcome unknown', { requestId, message: `no answer from the driver within ${SEND_TIMEOUT_MS / 1000}s` })
          return unknown(requestId)
        }),
      ])
    },

    arrived(db, p) {
      const r = recordArrivedEmail(db, {
        requestId: p.attemptRequestId, url: p.url, company: p.company, jobTitle: p.jobTitle,
        email: {
          applyAddress: p.applyAddress.trim(), senderAddress: p.senderAddress.trim(), subject: p.subject, body: p.body,
          attachmentNames: p.attachmentNames.map((n) => n.trim()), language: p.language,
          gmailMessageId: null, gmailThreadId: null, route: 'tool',
          aiDrafted: p.aiDrafted, edited: p.edited, model: p.model,
        },
      })
      if (!r.ok) throw new MailError('bad_request', notArrived(r.state))
      return { appliedJobId: r.job.id, markedAt: r.job.markedAt }
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
