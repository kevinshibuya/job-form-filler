import { SOURCE_BADGE, type Row } from './group'
import { BTN, BTN_PRIMARY, INPUT, MUTED, ROW_BASE, TIER_ACCENT, busyLabel } from './ui'

export interface FieldRowProps {
  row: Row
  edited: string | null
  onEdit: (ref: string, value: string) => void
  onAccept: (ref: string) => void
  onGenerate: (ref: string) => void
  /** Puts the row's current value on the page WITHOUT accepting it as a mapping. */
  onFill: (ref: string) => void
  generating: boolean
  filled: boolean
  /** Which of this row's page-writing actions is in flight, if any. */
  acting: 'accept' | 'fill' | null
}

export function FieldRow({ row, edited, onEdit, onAccept, onGenerate, onFill, generating, filled, acting }: FieldRowProps) {
  const { field, resolution, ref } = row
  const label = field.label ?? '(unlabelled field)'
  const value = edited ?? resolution.value ?? ''
  const rowClass = `${ROW_BASE} ${TIER_ACCENT[resolution.tier]}`

  if (resolution.tier === 'skipped') {
    return (
      <li className={rowClass}>
        <div className="flex items-baseline gap-1.5"><span className="font-semibold">{label}</span></div>
        <p className={`mt-1 text-[12px] ${MUTED}`}>Demographic question. Never auto-filled.</p>
      </li>
    )
  }

  return (
    <li className={rowClass}>
      <div className="flex items-baseline gap-1.5">
        <label className="font-semibold" htmlFor={`f-${ref}`}>{label}</label>
        {field.required && <span className="text-red-600 dark:text-red-400" title="required">*</span>}
        {resolution.source !== null && (
          <span className={`ml-auto rounded-full border border-neutral-200 px-1.5 text-[11px] dark:border-neutral-700 ${MUTED}`}>
            {SOURCE_BADGE[resolution.source]}
          </span>
        )}
      </div>

      <textarea
        id={`f-${ref}`}
        className={`${INPUT} mt-1.5 resize-y`}
        rows={value.length > 90 ? 4 : 1}
        value={value}
        onChange={(e) => onEdit(ref, e.target.value)}
      />

      {field.options.length > 0 && <p className={`mt-1 text-[12px] ${MUTED}`}>{field.options.join(', ')}</p>}

      <div className="mt-1.5 flex items-center gap-2">
        {resolution.tier === 'proposed' && (
          // Accept both fills the page AND confirms the mapping (App.onAccept).
          <button type="button" className={BTN_PRIMARY} disabled={acting !== null} onClick={() => onAccept(ref)}>
            {busyLabel(acting === 'accept', 'Accept', 'Accepting…')}
          </button>
        )}
        {resolution.tier === 'needs_input' && (
          <>
            <button type="button" className={BTN} disabled={generating || acting !== null} onClick={() => onGenerate(ref)}>
              {generating ? 'Drafting…' : 'Generate with AI'}
            </button>
            {/* Closes the spec's loop: generate, edit, then put it on the page.
                Unlike Accept this confirms NO mapping: a needs-input row has no
                key the LLM proposed, only an answer the user wrote. */}
            <button type="button" className={BTN_PRIMARY} disabled={value.trim() === '' || acting !== null} onClick={() => onFill(ref)}>
              {busyLabel(acting === 'fill', 'Fill', 'Filling…')}
            </button>
            {filled && <span className={`text-[11px] ${MUTED}`}>on the page</span>}
          </>
        )}
        <span className={`ml-auto font-mono text-[11px] ${MUTED}`} title={resolution.reason}>{resolution.reason}</span>
      </div>
    </li>
  )
}
