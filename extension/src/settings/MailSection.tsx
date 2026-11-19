import { useEffect, useRef, useState } from 'react'
import type { HostErrorKind, MailDisconnectResult, MailStatus } from '@jff/shared'
import { createHostPort, ERROR_COPY, type HostPort } from '../panel/port'
import { BTN } from '../panel/ui'
import { MailWizard } from './MailWizard'
import { CARD, H_SECTION, MUTED } from './look'

/** "November 19, 2026": the date a Mail account was connected. */
const sinceDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

/** The host's own message when it gives one, the generic copy otherwise. */
const failure = (error: { kind: HostErrorKind; message: string }): string =>
  error.message.trim() !== '' ? error.message : ERROR_COPY[error.kind]

/** The connected Mail account: which address and since when, and Disconnect
 *  beside it (spec #66). */
function MailAccount({ status, port, onDisconnected }: {
  status: Exclude<MailStatus, { state: 'none' }>
  port: () => HostPort
  onDisconnected: (result: MailDisconnectResult) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disconnect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = await port().request<MailDisconnectResult>('mail.disconnect', {})
    setBusy(false)
    if (!res.ok) setError(failure(res.error))
    else onDisconnected(res.result)
  }
  return (
    <section>
      <h2 className={H_SECTION}>Mail account</h2>
      <p className={`mt-0 mb-4 ${MUTED}`}>The tool sends an Application email from this account, and only on your click.</p>
      <div className={`${CARD} px-5 py-4`} data-jff-mail-account={status.state}>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className={`m-0 text-[12px] ${MUTED}`}>Gmail</p>
            <p className="mt-1 mb-0 text-[15px] font-medium">{status.address}</p>
            <p className={`mt-1 mb-0 ${MUTED}`}>Connected since {sinceDate(status.connectedAt)}</p>
          </div>
          <button type="button" className={BTN} disabled={busy} onClick={() => { void disconnect() }}>
            Disconnect
          </button>
        </div>
        {status.state === 'needs_reconnect' && (
          <p className="mt-3 mb-0 text-amber-700 dark:text-amber-400">
            The sign-in has expired or was revoked, so this account needs reconnecting before it can send.
          </p>
        )}
        {error !== null && (
          <p role="alert" className="mt-3 mb-0 whitespace-pre-line text-red-700 dark:text-red-400">{error}</p>
        )}
      </div>
    </section>
  )
}

/**
 * The settings page's Mail section: the wizard while there is no Mail
 * account, and the account once there is one. It holds one Native host port
 * for the page's life, so Connect's two requests reach the same process.
 */
export function MailSection() {
  const portRef = useRef<HostPort | null>(null)
  const port = (): HostPort => (portRef.current ??= createHostPort())
  const [status, setStatus] = useState<MailStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Why Google kept the token at the last Disconnect, shown over the wizard. */
  const [warning, setWarning] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void port().request<MailStatus>('mail.status', {}).then((res) => {
      if (!live) return
      if (res.ok) setStatus(res.result)
      else setError(res.error.message.trim() !== '' ? res.error.message : ERROR_COPY[res.error.kind])
    })
    return () => { live = false }
  }, [])

  useEffect(() => () => { portRef.current?.disconnect() }, [])

  // The console steps need no Native host: with no answer, they still show,
  // under the reason Connect will not work yet.
  if (error !== null) {
    return (
      <>
        <p role="alert" className="mt-0 mb-4 whitespace-pre-line text-red-700 dark:text-red-400">{error}</p>
        <MailWizard port={port} onConnected={(s) => { setError(null); setStatus(s) }} />
      </>
    )
  }
  if (status === null) return <p className={`m-0 ${MUTED}`}>Reading the Mail account…</p>
  if (status.state === 'none') {
    return (
      <>
        {warning !== null && (
          <p role="status" data-jff-disconnect-warning="1" className="mt-0 mb-4 whitespace-pre-line text-amber-700 dark:text-amber-400">
            {warning}
          </p>
        )}
        <MailWizard port={port} onConnected={(s) => { setWarning(null); setStatus(s) }} />
      </>
    )
  }
  return (
    <MailAccount
      status={status} port={port}
      onDisconnected={(r) => { setWarning(r.warning); setStatus({ state: 'none' }) }}
    />
  )
}
