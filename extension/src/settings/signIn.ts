import type { HostErrorKind, MailConnectStartResult, MailStatus } from '@jff/shared'
import { ERROR_COPY, type HostPort } from '../panel/port'

/** The host's own message when it gives one: it names the fix (a Desktop
 *  client, Connect again). The generic copy only when it says nothing. */
export const failure = (error: { kind: HostErrorKind; message: string }): string =>
  error.message.trim() !== '' ? error.message : ERROR_COPY[error.kind]

/**
 * One sign-in, as Connect and Reconnect run it (spec #66): ask the Native host
 * for the consent address, open it in a tab of this Chrome, and wait for the
 * sign-in to come back. With a client file it is Connect; with none it is
 * Reconnect, and the Native host uses the stored client. Both requests go
 * through the same port, so they reach the same Native host process.
 */
export async function runSignIn(
  host: HostPort, clientFile: string | null, onWaiting: () => void,
): Promise<{ ok: true; status: MailStatus } | { ok: false; message: string }> {
  const start = await host.request<MailConnectStartResult>('mail.connect.start', clientFile === null ? {} : { clientFile })
  if (!start.ok) return { ok: false, message: failure(start.error) }
  await chrome.tabs.create({ url: start.result.consentUrl })
  onWaiting()
  const done = await host.request<MailStatus>('mail.connect.finish', {})
  return done.ok ? { ok: true, status: done.result } : { ok: false, message: failure(done.error) }
}
