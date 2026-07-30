import { useEffect, useState } from 'react'
import { MUTED, ROW_BASE } from './ui'

export interface AppliedJobRow {
  id: number
  url: string
  canonicalUrl: string
  company: string | null
  jobTitle: string | null
  markedAt: string
}

/** Stored urls are data, not trust: a `javascript:`/`data:` url in the DB would
 *  otherwise become a clickable link. Only http(s) earns an anchor. */
const isWebUrl = (raw: string): boolean => {
  try { const p = new URL(raw).protocol; return p === 'http:' || p === 'https:' } catch { return false }
}

/** A5: read-only v1. `load` resolves null on a host failure (App owns the banner);
 *  a REJECTION is the same failure — never leave the view stuck on "Loading…". */
export function ApplicationsView({ load }: { load: () => Promise<AppliedJobRow[] | null> }) {
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
            </div>
            {j.company !== null && <div className={`mt-0.5 ${MUTED}`}>{j.company}</div>}
            {isWebUrl(j.url)
              ? <a className="text-[12px] text-blue-700 underline dark:text-blue-300" href={j.url} target="_blank" rel="noreferrer">Open posting</a>
              : <div className={`text-[12px] ${MUTED}`}>{j.url}</div>}
          </li>
        ))}
      </ul>
    </section>
  )
}
