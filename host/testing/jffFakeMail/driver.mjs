// Test-only. A Mail account driver that reaches no network (spec #66), for the
// request handler tests and the browser test. It lives outside host/src, so
// the Native host's shipped output never holds it. The build proof greps
// host/dist for the marker, which is also this directory's name: tsc copies
// no module from here into dist, but an import of one from shipped code
// carries the path, and with it the marker, into dist.
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
 * makes connect refuse the file with that message. `senders` is the "Send
 * mail as" list it answers after the account's own address, which has no
 * name; `sendersFail` makes the list throw, as a dead sign-in does.
 * `send` records each email and answers the ids `MESSAGE_ID_PLACEHOLDER_<n>`
 * and `THREAD_ID_PLACEHOLDER_<n>`; `sendFails` makes it throw.
 */
export function createFakeMailDriver(opts = {}) {
  const account = { ...PERSONA, ...(opts.account ?? {}) }
  let current = null
  const driver = {
    kind: 'gmail',
    /** Every client file connect was given, in order. */
    clientFiles: [],
    /** Every stored client a Reconnect was given, in order. */
    storedClients: [],
    /** Every account the Sender addresses were asked for, in order. */
    senderCalls: [],
    /** The account's other verified addresses, after its own. */
    senders: opts.senders ?? [],
    /** Set to an error to make the Sender addresses throw it. */
    sendersFail: opts.sendersFail ?? null,
    async senderAddresses(signedIn) {
      driver.senderCalls.push({ ...signedIn })
      if (driver.sendersFail !== null) throw driver.sendersFail
      return [{ address: signedIn.address, displayName: null }, ...driver.senders.map((s) => ({ ...s }))]
    },
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
    /** Every send, in order: the account it went from and the email, its
     *  attachment's bytes as a Buffer. */
    sent: [],
    /** Set to an error to make send throw it, as a refusal from Gmail does. */
    sendFails: opts.sendFails ?? null,
    /** Called with each send before it settles; what it returns (a promise
     *  too) is awaited, so a test can look at the database mid-Send or hold
     *  the Send open. */
    onSend: opts.onSend ?? null,
    async send(signedIn, email) {
      driver.sent.push({ account: { ...signedIn }, email: { ...email, from: { ...email.from }, attachment: { ...email.attachment } } })
      if (driver.onSend !== null) await driver.onSend(signedIn, email)
      if (driver.sendFails !== null) throw driver.sendFails
      return { messageId: `MESSAGE_ID_PLACEHOLDER_${driver.sent.length}`, threadId: `THREAD_ID_PLACEHOLDER_${driver.sent.length}` }
    },
    async connect(client) {
      if (typeof client === 'string') driver.clientFiles.push(client)
      else driver.storedClients.push({ ...client })
      if (typeof client === 'string' && opts.refuseClientFile !== undefined) throw mailError('bad_request', opts.refuseClientFile)
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
