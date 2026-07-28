import type { FrameReport } from './scan'
import { MUTED } from './ui'

export type ScanUiState =
  | { kind: 'connecting' }
  | { kind: 'injecting' }
  | { kind: 'enumerating'; frames: number }
  | { kind: 'retrying' }
  | { kind: 'resolving'; fields: number }
  | { kind: 'done'; filled: number; proposed: number; needsInput: number }
  | { kind: 'empty'; frames: number }
  | { kind: 'captcha' }
  | { kind: 'failed'; reason: string }
  | { kind: 'action_failed'; reason: string }

function copyFor(s: ScanUiState): string {
  switch (s.kind) {
    case 'connecting': return 'Waiting for the local host…'
    case 'injecting': return 'Reaching into the page…'
    case 'enumerating': return `Scanning page (${s.frames} frames)…`
    case 'retrying': return 'No fields yet — looking again…'
    case 'resolving': return `Matching ${s.fields} fields… (a Claude call can take a minute)`
    case 'done': return `✓ ${s.filled} filled, ${s.proposed} proposed, ${s.needsInput} need input`
    case 'empty': return `⚠ Scanned ${s.frames} frames, found no form fields. Open the application form, then Scan again.`
    case 'captcha': return '⚠ CAPTCHA active — nothing was filled.'
    case 'failed': return `✕ Scan failed: ${s.reason}`
    case 'action_failed': return `✕ ${s.reason}`
  }
}

const TONE: Record<ScanUiState['kind'], string> = {
  connecting: MUTED, injecting: MUTED, enumerating: MUTED, retrying: MUTED, resolving: MUTED,
  done: 'text-green-700 dark:text-green-400',
  empty: 'text-amber-600 dark:text-amber-400',
  captcha: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
  action_failed: 'text-red-600 dark:text-red-400',
}

/** One-line scan status + collapsible per-frame evidence. Diagnostics render only
 *  for settled outcomes: mid-scan the report list is last scan's, not this one's. */
export function ScanStatus({ status, reports }: { status: ScanUiState | null; reports: FrameReport[] }) {
  if (status === null) return null
  const settledWithEvidence =
    status.kind === 'empty' || status.kind === 'failed' ||
    (status.kind === 'done' && reports.some((r) => r.error !== null))
  return (
    <div className="my-2 text-[12px]" data-jff-status={status.kind} role="status">
      <p className={`m-0 ${TONE[status.kind]}`}>{copyFor(status)}</p>
      {settledWithEvidence && reports.length > 0 && (
        <details className="mt-1" data-jff-diagnostics="1">
          <summary className={`cursor-pointer ${MUTED}`}>details</summary>
          <ul className={`m-0 mt-1 list-none p-0 font-mono text-[11px] ${MUTED}`}>
            {/* index key: after a retry the same frameId can legitimately appear twice */}
            {reports.map((r, i) => (
              <li className="my-0.5 truncate" key={i} title={r.url ?? undefined}>
                {r.frameId === -1 ? 'relay' : `frame ${r.frameId}`} · {r.url ?? '(no url)'} · {r.error !== null ? r.error : `${r.fields ?? 0} fields`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
