import { createHash, randomBytes } from 'node:crypto'
import {
  MailError, type ConnectedAccount, type MailAccountDriver, type PendingConnect, type SenderAddressEntry, type SignedInAccount,
} from './account.js'
import { startLoopbackListener, type LoopbackListener } from './loopback.js'
import { googleOnly, type HttpCall } from './net.js'

/**
 * The research document's line `Sender addresses:` (answer 2): `dropdown` when
 * an unverified client may read the "Send mail as" list, `own address only`
 * when it may not. gmailConnect.test.ts holds this to the document's line.
 */
export type SenderAddressesMode = 'dropdown' | 'own address only'
export const SENDER_ADDRESSES: SenderAddressesMode = 'dropdown'

const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send'
const GMAIL_SETTINGS = 'https://www.googleapis.com/auth/gmail.settings.basic'

/** The scopes the sign-in asks for. Nothing that reads mail, in either mode. */
export function gmailScopes(mode: SenderAddressesMode): string[] {
  return mode === 'dropdown' ? [GMAIL_SEND, GMAIL_SETTINGS, 'openid', 'email'] : [GMAIL_SEND, 'openid', 'email']
}

export const CONSENT_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const SEND_AS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs'

/** An access token is asked for again this long before Google says it expires. */
const TOKEN_MARGIN_MS = 60_000

const SIGN_IN_DIED =
  'Google refused the stored sign-in: it has expired or was revoked. Click Reconnect to sign in again. Your Draft is kept.'

/** A parsed JSON body, or an empty object when it is not one. */
function jsonOf(body: string): Record<string, unknown> {
  try {
    const v = JSON.parse(body) as unknown
    return typeof v === 'object' && v !== null ? v as Record<string, unknown> : {}
  } catch { return {} }
}

const WRONG_FILE =
  'This is not the client file of a Desktop app. In the Google Cloud console, create an OAuth client whose ' +
  'Application type is Desktop app, click Download JSON, and give the wizard that file.'

/** Google's downloaded JSON for a Desktop client: its id and secret under `installed`. */
export function parseClientFile(text: string): { clientId: string; clientSecret: string } {
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new MailError('bad_request', WRONG_FILE) }
  const installed = (json as { installed?: unknown } | null)?.installed as { client_id?: unknown; client_secret?: unknown } | undefined
  if (installed === undefined || installed === null || typeof installed !== 'object') {
    const web = typeof json === 'object' && json !== null && 'web' in json
    throw new MailError('bad_request', web ? `This client file is for a Web application. ${WRONG_FILE}` : WRONG_FILE)
  }
  const { client_id: clientId, client_secret: clientSecret } = installed
  if (typeof clientId !== 'string' || clientId === '' || typeof clientSecret !== 'string' || clientSecret === '') {
    throw new MailError('bad_request', WRONG_FILE)
  }
  return { clientId, clientSecret }
}

const b64url = (b: Buffer): string => b.toString('base64url')

/** The address an ID token names. It came straight from Google's token
 *  endpoint over TLS, so its audience is checked and its signature is not. */
function addressFromIdToken(idToken: unknown, clientId: string): string {
  const payload = typeof idToken === 'string' ? idToken.split('.')[1] : undefined
  let claims: { aud?: unknown; email?: unknown } = {}
  try { claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as typeof claims } catch { /* below */ }
  if (claims.aud !== clientId) throw new MailError('invalid_output', 'Google\'s answer did not name this client. Nothing was connected.')
  if (typeof claims.email !== 'string' || claims.email === '') {
    throw new MailError('invalid_output', 'Google\'s answer named no email address. Nothing was connected.')
  }
  return claims.email
}

export interface GmailDriverDeps {
  /** The one network call; every address goes through Google's guard. */
  http: HttpCall
  senderAddresses?: SenderAddressesMode
  listen?: (state: string) => Promise<LoopbackListener>
  /** The clock an access token expires by, in milliseconds. */
  now?: () => number
}

/** The Gmail Mail account driver. */
export function createGmailDriver(deps: GmailDriverDeps): MailAccountDriver {
  const http = googleOnly(deps.http)
  const mode = deps.senderAddresses ?? SENDER_ADDRESSES
  const scopes = gmailScopes(mode)
  const listen = deps.listen ?? startLoopbackListener
  const now = deps.now ?? Date.now
  /** Access tokens, by the refresh token they came from. Memory only. */
  const tokens = new Map<string, { token: string; until: number }>()

  /** A call to Google; a failure to reach it is a MailError naming `what`. */
  async function call(req: Parameters<typeof http>[0], what: string): Promise<{ status: number; body: string }> {
    try {
      return await http(req)
    } catch (e) {
      if (e instanceof MailError) throw e
      throw new MailError('process', `Could not reach Google to ${what}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** An access token from the refresh token (the research transcript's
   *  order). Only `invalid_grant` means the sign-in died. */
  async function accessToken(account: SignedInAccount): Promise<string> {
    const held = tokens.get(account.refreshToken)
    if (held !== undefined && held.until > now()) return held.token
    const res = await call({
      method: 'POST', url: TOKEN_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: account.refreshToken,
        client_id: account.clientId, client_secret: account.clientSecret,
      }).toString(),
    }, 'refresh the sign-in')
    const json = jsonOf(res.body)
    if (res.status !== 200) {
      if (json.error === 'invalid_grant') throw new MailError('not_authed', SIGN_IN_DIED)
      const what = typeof json.error === 'string' ? ` ${json.error}` : ''
      throw new MailError('process', `Google did not refresh the sign-in (${res.status}${what}). Try again in a moment.`)
    }
    if (typeof json.access_token !== 'string' || json.access_token === '') {
      throw new MailError('invalid_output', 'Google\'s answer to a refresh held no access token.')
    }
    const seconds = typeof json.expires_in === 'number' ? json.expires_in : 0
    tokens.set(account.refreshToken, { token: json.access_token, until: now() + seconds * 1000 - TOKEN_MARGIN_MS })
    return json.access_token
  }

  async function exchange(
    code: string, verifier: string, redirectUri: string, client: { clientId: string; clientSecret: string },
  ): Promise<ConnectedAccount> {
    // The transcript's order. Answer 4: Google refuses the exchange without the secret.
    const body = new URLSearchParams({
      code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri,
      client_id: client.clientId, client_secret: client.clientSecret,
    }).toString()
    let res
    try {
      res = await http({ method: 'POST', url: TOKEN_URL, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    } catch (e) {
      if (e instanceof MailError) throw e
      throw new MailError('process', `Could not reach Google to finish the sign-in: ${e instanceof Error ? e.message : String(e)}`)
    }
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(res.body) as Record<string, unknown> } catch { /* below */ }
    if (res.status !== 200) {
      const what = [json.error, json.error_description].filter((v) => typeof v === 'string').join(': ')
      throw new MailError('not_authed', `Google refused the sign-in (${res.status}${what === '' ? '' : ` ${what}`}). Nothing was connected.`)
    }
    const granted = typeof json.scope === 'string' ? json.scope.split(' ') : []
    const missing = scopes.filter((s) => s.startsWith('https://www.googleapis.com/auth/gmail.') && !granted.includes(s))
    if (missing.length > 0) {
      throw new MailError('not_authed',
        `Google did not grant ${missing.map((s) => s.replace('https://www.googleapis.com/auth/', '')).join(' and ')}. ` +
        'Click Connect again and tick every Gmail box on the permissions page.')
    }
    if (typeof json.refresh_token !== 'string' || json.refresh_token === '') {
      throw new MailError('invalid_output', 'Google\'s answer held no refresh token. Nothing was connected.')
    }
    return {
      address: addressFromIdToken(json.id_token, client.clientId),
      clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: json.refresh_token,
    }
  }

  return {
    kind: 'gmail',
    async connect(source): Promise<PendingConnect> {
      const client = typeof source === 'string' ? parseClientFile(source) : source
      const verifier = b64url(randomBytes(32))
      const state = b64url(randomBytes(24))
      const listener = await listen(state)
      const consent = new URL(CONSENT_URL)
      for (const [k, v] of Object.entries({
        client_id: client.clientId,
        redirect_uri: listener.redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
      })) consent.searchParams.set(k, v)
      const result = listener.code.then((code) => exchange(code, verifier, listener.redirectUri, client))
      return {
        consentUrl: consent.toString(),
        result,
        cancel: () => listener.close(new MailError('timeout', 'The sign-in was stopped before it came back. Nothing was connected.')),
      }
    },

    // The account's own address, then each "Send mail as" entry Gmail has
    // verified (answer 3: Gmail sends from the own address, silently, when
    // From is any other). The primary entry carries no verificationStatus.
    async senderAddresses(account): Promise<SenderAddressEntry[]> {
      const token = await accessToken(account)
      const own: SenderAddressEntry = { address: account.address, displayName: null }
      if (mode === 'own address only') return [own]
      const res = await call({ method: 'GET', url: SEND_AS_URL, headers: { authorization: `Bearer ${token}` } }, 'read the "Send mail as" addresses')
      if (res.status !== 200) {
        throw new MailError('process', `Gmail did not list the "Send mail as" addresses (${res.status}). Try again in a moment.`)
      }
      const entries = Array.isArray(jsonOf(res.body).sendAs) ? jsonOf(res.body).sendAs as Record<string, unknown>[] : []
      const others: SenderAddressEntry[] = []
      for (const e of entries) {
        if (typeof e !== 'object' || e === null || typeof e.sendAsEmail !== 'string' || e.sendAsEmail === '') continue
        const name = typeof e.displayName === 'string' && e.displayName.trim() !== '' ? e.displayName.trim() : null
        if (e.sendAsEmail.toLowerCase() === account.address.toLowerCase()) {
          own.displayName = name
          continue
        }
        if (e.isPrimary !== true && e.verificationStatus !== 'accepted') continue
        if (others.some((o) => o.address.toLowerCase() === (e.sendAsEmail as string).toLowerCase())) continue
        others.push({ address: e.sendAsEmail, displayName: name })
      }
      return [own, ...others]
    },

    // The research document's Revocation: a POST of the refresh token, which
    // Google answers 200 with `{}`. The token never goes in an error message.
    async revoke(refreshToken: string): Promise<void> {
      let res
      try {
        res = await http({
          method: 'POST', url: REVOKE_URL,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refreshToken }).toString(),
        })
      } catch (e) {
        if (e instanceof MailError) throw e
        throw new MailError('process', `Could not reach Google to revoke the sign-in: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (res.status === 200) return
      let json: Record<string, unknown> = {}
      try { json = JSON.parse(res.body) as Record<string, unknown> } catch { /* below */ }
      const what = typeof json.error === 'string' ? ` ${json.error}` : ''
      throw new MailError('not_authed', `Google refused to revoke the sign-in (${res.status}${what}).`)
    },
  }
}
