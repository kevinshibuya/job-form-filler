import { useEffect, useState } from 'react'
import type { AppliedChannel, AppliedTexts, ApplicationEmail, EmailRoute } from '@jff/shared'
import { BTN, MUTED, ROW_BASE } from './ui'

export interface AppliedJobRow {
  id: number
  url: string
  canonicalUrl: string
  company: string | null
  jobTitle: string | null
  markedAt: string
  /** How the application went out (spec #66). */
  channel: AppliedChannel
}

const CHANNEL_LABEL: Record<AppliedChannel, string> = { form: 'Form', email: 'Email' }

/** Stored urls are data, not trust: a `javascript:`/`data:` url in the DB would
 *  otherwise become a clickable link. Only http(s) earns an anchor. */
const isWebUrl = (raw: string): boolean => {
  try { const p = new URL(raw).protocol; return p === 'http:' || p === 'https:' } catch { return false }
}

const ROUTE_LABEL: Record<EmailRoute, string> = { tool: 'Sent from job-form-filler', mail_app: 'Handed to your mail app' }

/** One kept Application email, read only: text, never a control. The body
 *  keeps its line breaks. One the tool sent shows its Sender address, its
 *  attachment names and the time it left (ticket #82). */
function KeptEmail({ email }: { email: ApplicationEmail }) {
  return (
    <article className="mt-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-700" data-jff-app-email="1">
      <div className={`text-[12px] ${MUTED}`}>
        <time className="tabular-nums" dateTime={email.sentAt} data-jff-app-email-time="1">{new Date(email.sentAt).toLocaleString()}</time> · {ROUTE_LABEL[email.route]}
      </div>
      <div className="mt-1 break-all text-[12px]" data-jff-app-email-to="1"><span className="font-semibold">To</span> {email.applyAddress}</div>
      {email.senderAddress !== null && (
        <div className="break-all text-[12px]" data-jff-app-email-from="1"><span className="font-semibold">From</span> {email.senderAddress}</div>
      )}
      <div className="mt-1 font-semibold" data-jff-app-email-subject="1">{email.subject}</div>
      <div className="mt-1 whitespace-pre-wrap break-words" data-jff-app-email-body="1">{email.body}</div>
      {email.attachmentNames.length > 0 && (
        <div className={`mt-1 break-all text-[12px] ${MUTED}`} data-jff-app-email-attachments="1">Attached: {email.attachmentNames.join(', ')}</div>
      )}
      {email.aiDrafted && (
        <div className={`mt-1 text-[12px] ${MUTED}`}>
          Drafted by {email.model ?? 'AI'}{email.edited && ' · edited by you'}
        </div>
      )}
    </article>
  )
}

type EmailsState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'shown'; emails: ApplicationEmail[] }

/** An email Applied job's Application emails, read when the user opens them,
 *  in the order the Native host gives: newest first. */
function KeptEmails({ id, loadTexts }: { id: number; loadTexts: (id: number) => Promise<AppliedTexts | null> }) {
  const [state, setState] = useState<EmailsState>({ kind: 'loading' })
  useEffect(() => {
    void loadTexts(id).then(
      (texts) => { setState(texts === null ? { kind: 'failed' } : { kind: 'shown', emails: texts.emails }) },
      () => { setState({ kind: 'failed' }) },
    )
  }, [id])
  if (state.kind === 'loading') return <p className={`mt-2 text-[12px] ${MUTED}`}>Loading…</p>
  if (state.kind === 'failed') return <p className="mt-2 text-[12px] text-red-600 dark:text-red-400">Could not load the Application email.</p>
  if (state.emails.length === 0) return <p className={`mt-2 text-[12px] ${MUTED}`}>No Application email was kept for this application.</p>
  return <>{state.emails.map((e, i) => <KeptEmail key={i} email={e} />)}</>
}

/** A5: read-only v1. `load` resolves null on a host failure (App owns the banner);
 *  a REJECTION is the same failure — never leave the view stuck on "Loading…".
 *  `loadTexts` reads one Applied job's stored texts (spec #66): an email
 *  Applied job opens to its Application emails. */
export function ApplicationsView({ load, loadTexts }: {
  load: () => Promise<AppliedJobRow[] | null>
  loadTexts?: (id: number) => Promise<AppliedTexts | null>
}) {
  const [open, setOpen] = useState<number | null>(null)
  const [jobs, setJobs] = useState<AppliedJobRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void load().then(
      (rows) => { if (rows === null) setFailed(true); else setJobs(rows) },
      () => { setFailed(true) },
    )
  }, [])
  if (failed) return <p className={`mt-3 ${MUTED}`} data-jff-apps="error">Could not load your applications.</p>
  if (jobs === null) return <p className={`mt-3 ${MUTED}`} data-jff-apps="loading">Loading…</p>
  return (
    <section className="mt-3" data-jff-apps="1">
      <h2 className="mb-1 text-[13px] font-semibold">Applied jobs ({jobs.length})</h2>
      {jobs.length === 0 && <p className={MUTED}>Nothing marked applied yet.</p>}
      <ul className="m-0 grid list-none gap-2 p-0">
        {jobs.map((j) => (
          <li className={`${ROW_BASE} border-l-neutral-300 dark:border-l-neutral-600`} key={j.id}>
            <div className="flex items-baseline gap-1.5">
              <span className="font-semibold">{j.jobTitle ?? j.company ?? j.url}</span>
              <span className={`${MUTED} tabular-nums`}>{new Date(j.markedAt).toLocaleDateString()}</span>
              <span className={MUTED} data-jff-app-channel={j.channel}>{CHANNEL_LABEL[j.channel]}</span>
            </div>
            {j.company !== null && <div className={`mt-0.5 ${MUTED}`}>{j.company}</div>}
            {isWebUrl(j.url)
              ? <a className="text-[12px] text-blue-700 underline dark:text-blue-300" href={j.url} target="_blank" rel="noreferrer">Open posting</a>
              : <div className={`text-[12px] ${MUTED}`}>{j.url}</div>}
            {j.channel === 'email' && loadTexts !== undefined && (
              <>
                <div className="mt-1.5">
                  <button type="button" className={BTN} aria-expanded={open === j.id} onClick={() => setOpen((o) => (o === j.id ? null : j.id))}>
                    {open === j.id ? 'Hide the Application email' : 'Show the Application email'}
                  </button>
                </div>
                {open === j.id && <KeptEmails id={j.id} loadTexts={loadTexts} />}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
