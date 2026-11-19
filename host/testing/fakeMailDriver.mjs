// Test-only. A Mail account driver that reaches no network (spec #66), for the
// request handler tests and the browser test. It lives outside host/src, so
// the Native host's shipped output never holds it; the build proof greps
// host/dist for the marker below.
export const FAKE_MAIL_MARKER = 'jffFakeMail'

/** A Mail account failure, shaped as host/src/mail/account.ts's MailError. */
export function mailError(kind, message) {
  return Object.assign(new Error(message), { name: 'MailError', kind })
}

const PERSONA = {
  address: 'ada@example.com',
  clientId: 'CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com',
  clientSecret: 'CLIENT_SECRET_PLACEHOLDER',
  refreshToken: 'REFRESH_TOKEN_PLACEHOLDER',
}

/**
 * A fake Gmail driver. With `signIn: 'auto'` (the default) a sign-in returns
 * at once; with `signIn: 'manual'` it waits for `returnSignIn()` or
 * `refuseSignIn()`, and with `'never'` it never returns. `refuseClientFile`
 * makes connect refuse the file with that message.
 */
export function createFakeMailDriver(opts = {}) {
  const account = { ...PERSONA, ...(opts.account ?? {}) }
  let current = null
  const driver = {
    kind: 'gmail',
    /** Every client file connect was given, in order. */
    clientFiles: [],
    /** How many sign-ins were cancelled. */
    cancelled: 0,
    /** Every refresh token revoke was given, in order. */
    revoked: [],
    /** Set to an error to make revoke throw it, as Google out of reach does. */
    revokeFails: opts.revokeFails ?? null,
    async revoke(refreshToken) {
      driver.revoked.push(refreshToken)
      if (driver.revokeFails !== null) throw driver.revokeFails
    },
    async connect(clientFile) {
      driver.clientFiles.push(clientFile)
      if (opts.refuseClientFile !== undefined) throw mailError('bad_request', opts.refuseClientFile)
      let settle
      const result = new Promise((resolve, reject) => { settle = { resolve, reject } })
      result.catch(() => {})
      let done = false
      const end = (fn) => { if (!done) { done = true; fn() } }
      current = {
        returnSignIn: () => end(() => settle.resolve({ ...account })),
        refuseSignIn: (kind, message) => end(() => settle.reject(mailError(kind, message))),
      }
      if ((opts.signIn ?? 'auto') === 'auto') current.returnSignIn()
      return {
        consentUrl: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(account.clientId)}&state=fake`,
        result,
        cancel: () => end(() => { driver.cancelled++; settle.reject(mailError('timeout', 'The sign-in was stopped before it came back.')) }),
      }
    },
    /** The waiting sign-in returns from Google with the account. */
    returnSignIn: () => current?.returnSignIn(),
    /** The waiting sign-in comes back refused, as a wrong state would. */
    refuseSignIn: (kind = 'bad_request', message = 'The sign-in came back with a state that does not match.') =>
      current?.refuseSignIn(kind, message),
  }
  return driver
}
