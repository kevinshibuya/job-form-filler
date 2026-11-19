import { useState, type DragEvent } from 'react'
import type { MailStatus } from '@jff/shared'
import type { HostPort } from '../panel/port'
import { BTN_PRIMARY } from '../panel/ui'
import { CARD, MUTED } from './look'
import { runSignIn } from './signIn'

const readText = (f: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(reader.error ?? new Error('could not read the file'))
  reader.readAsText(f)
})

/** The client file as read, held in this page's memory only: it carries the
 *  client secret, which the Native host puts in the Keychain. */
interface ClientFile { name: string; text: string }

/**
 * The wizard's last two steps (spec #66): the client file downloaded in the
 * console, then Connect. They continue the console steps' cards and numbers.
 * Connect asks the Native host for the consent address, opens it in a tab of
 * this Chrome, and waits for the sign-in to come back.
 */
export function ConnectSteps({ first, port, onConnected }: {
  /** The number of the first of the two cards. */
  first: number
  port: () => HostPort
  onConnected: (status: MailStatus) => void
}) {
  const [file, setFile] = useState<ClientFile | null>(null)
  const [phase, setPhase] = useState<'idle' | 'starting' | 'waiting'>('idle')
  const [error, setError] = useState<string | null>(null)

  const take = async (f: File | undefined): Promise<void> => {
    if (f === undefined) return
    setError(null)
    setFile({ name: f.name, text: await readText(f) })
  }

  const onDrop = (e: DragEvent<HTMLElement>): void => {
    e.preventDefault()
    void take(e.dataTransfer.files[0])
  }

  const connect = async (): Promise<void> => {
    if (file === null) return
    setError(null)
    setPhase('starting')
    const done = await runSignIn(port(), file.text, () => setPhase('waiting'))
    setPhase('idle')
    if (!done.ok) {
      setError(done.message)
      return
    }
    onConnected(done.status)
  }

  return (
    <>
      <li className={`${CARD} px-5 py-4`} data-jff-connect-step="file">
        <h3 className="m-0 text-[15px] font-medium">{first}. Give the wizard your client file</h3>
        <p className={`mt-1 mb-0 ${MUTED}`}>
          Drop the JSON you downloaded in step 5 here, or choose it. The client secret in it goes to your Keychain, never to a file.
        </p>
        <label
          className="mt-3 block rounded-lg border border-dashed border-neutral-300 px-4 py-4 dark:border-neutral-700"
          data-jff-client-drop="1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
        >
          <span className={`mb-1 block ${MUTED}`}>Client file</span>
          <input
            type="file" accept=".json,application/json" onChange={(e) => { void take(e.target.files?.[0]) }}
            className="block w-full text-[12px] file:mr-2 file:cursor-pointer file:rounded-md file:border file:border-neutral-300 file:bg-transparent file:px-2 file:py-1 file:text-[12px] file:text-inherit dark:file:border-neutral-600"
          />
          {file !== null && <span className="mt-2 block text-[13px]">Read {file.name}</span>}
        </label>
      </li>
      <li className={`${CARD} px-5 py-4`} data-jff-connect-step="connect">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="m-0 text-[15px] font-medium">{first + 1}. Connect</h3>
            <p className={`mt-1 mb-0 ${MUTED}`}>
              Connect opens Google&apos;s sign-in in a new tab. Step 8 says what to expect there.
            </p>
          </div>
          <button
            type="button" className={BTN_PRIMARY} disabled={file === null || phase !== 'idle'}
            onClick={() => { void connect() }}
          >
            Connect
          </button>
        </div>
        {phase === 'waiting' && (
          <p className={`mt-3 mb-0 ${MUTED}`}>Waiting for the sign-in in the tab that opened…</p>
        )}
        {error !== null && (
          <p role="alert" className="mt-3 mb-0 whitespace-pre-line text-red-700 dark:text-red-400">{error}</p>
        )}
      </li>
    </>
  )
}
