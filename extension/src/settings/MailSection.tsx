import { useEffect, useRef, useState } from 'react'
import { MailSendersResultSchema, type MailDisconnectResult, type MailStatus, type SenderAddress } from '@jff/shared'
import { createHostPort, ERROR_COPY, type HostPort } from '../panel/port'
import { BTN, BTN_PRIMARY } from '../panel/ui'
import { MailWizard } from './MailWizard'
import { CARD, H_SECTION, MUTED } from './look'
import { failure, runSignIn } from './signIn'

/** "November 19, 2026": the date a Mail account was connected. */
const sinceDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

const STATE_NAME: Record<Exclude<MailStatus, { state: 'none' }>['state'], string> = {
  connected: 'Connected',
  needs_reconnect: 'Needs reconnect',
}

/**
 * The connected Mail account (spec #66): which address, since when and in
 * what state, its Sender addresses, and Disconnect beside it. When the
 * sign-in died, Reconnect runs it again with the stored client, and the
 * Sender addresses wait for it. A list that finds the sign-in dead turns the
 * state to "Needs reconnect" here too.
 */
function MailAccount({ status, port, onStatus, onDisconnected }: {
  status: Exclude<MailStatus, { state: 'none' }>
  port: () => HostPort
  onStatus: (status: MailStatus) => void
  onDisconnected: (result: MailDisconnectResult) => void
}) {
  const [busy, setBusy] = useState<'disconnect' | 'reconnect' | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [senders, setSenders] = useState<SenderAddress[] | null>(null)

  useEffect(() => {
    if (status.state !== 'connected') return
    let live = true
    setSenders(null)
    void port().request('mail.senders', {}).then((res) => {
      if (!live) return
      if (!res.ok) {
        if (res.error.kind === 'not_authed') onStatus({ ...status, state: 'needs_reconnect' })
        else setError(failure(res.error))
        return
      }
      const parsed = MailSendersResultSchema.safeParse(res.result)
      if (parsed.success) setSenders(parsed.data.senders)
    })
    return () => { live = false }
  }, [status.state, status.address])

  const disconnect = async (): Promise<void> => {
    setBusy('disconnect')
    setError(null)
    const res = await port().request<MailDisconnectResult>('mail.disconnect', {})
    setBusy(null)
    if (!res.ok) setError(failure(res.error))
    else onDisconnected(res.result)
  }

  const reconnect = async (): Promise<void> => {
    setBusy('reconnect')
    setError(null)
    const done = await runSignIn(port(), null, () => setWaiting(true))
    setBusy(null)
    setWaiting(false)
    if (!done.ok) setError(done.message)
    else onStatus(done.status)
  }

  const died = status.state === 'needs_reconnect'
  return (
    <section>
      <h2 className={H_SECTION}>Mail account</h2>
      <p className={`mt-0 mb-4 ${MUTED}`}>The tool sends an Application email from this account, and only on your click.</p>
      <div className={`${CARD} px-5 py-4`} data-jff-mail-account={status.state}>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className={`m-0 text-[12px] ${MUTED}`}>Gmail</p>
            <p className="mt-1 mb-0 text-[15px] font-medium" data-jff-mail-address="1">{status.address}</p>
            <p className={`mt-1 mb-0 ${MUTED}`}>Connected since {sinceDate(status.connectedAt)}</p>
            <p
              className={`mt-1 mb-0 font-medium ${died ? 'text-amber-700 dark:text-amber-400' : 'text-green-700 dark:text-green-400'}`}
              data-jff-mail-state={status.state}
            >
              {STATE_NAME[status.state]}
            </p>
          </div>
          <div className="flex gap-2">
            {died && (
              <button type="button" className={BTN_PRIMARY} disabled={busy !== null} onClick={() => { void reconnect() }}>
                Reconnect
              </button>
            )}
            <button type="button" className={BTN} disabled={busy !== null} onClick={() => { void disconnect() }}>
              Disconnect
            </button>
          </div>
        </div>
        {died && (
          <p className="mt-3 mb-0 text-amber-700 dark:text-amber-400">
            The sign-in has expired or was revoked, so this account needs reconnecting before it can send. Reconnect signs in again with the client you gave the wizard.
          </p>
        )}
        {waiting && <p className={`mt-3 mb-0 ${MUTED}`}>Waiting for the sign-in in the tab that opened…</p>}
        {!died && senders !== null && (
          <div className="mt-4" data-jff-sender-addresses="1">
            <h3 className="m-0 text-[13px] font-medium">Sender addresses</h3>
            <p className={`mt-1 mb-2 ${MUTED}`}>The addresses an Application email can go from. You choose one in each email&apos;s Review.</p>
            <ul className="m-0 list-none p-0">
              {senders.map((s) => (
                <li key={s.address} className="py-1" data-jff-sender-address={s.address}>
                  {s.displayName !== '' && <span className="font-medium">{s.displayName} </span>}
                  <span className={MUTED}>{s.address}</span>
                </li>
              ))}
            </ul>
          </div>
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
      status={status} port={port} onStatus={setStatus}
      onDisconnected={(r) => { setWarning(r.warning); setStatus({ state: 'none' }) }}
    />
  )
}
