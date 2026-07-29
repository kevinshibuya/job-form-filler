import type { ResolutionTier } from '@jff/shared'
import { SOURCE_BADGE, type Row } from './group'
import { scoreResumeField } from './resumeTarget'
import { BTN, BTN_PRIMARY, INPUT, MUTED, ROW_BASE, TIER_ACCENT, busyLabel } from './ui'

export const TIER_BADGE: Record<ResolutionTier, string> = {
  auto: 'filled', proposed: 'proposed', needs_input: 'needs input', skipped: 'skipped',
}

/**
 * First-class refusal reasons rendered as a human hint under the row. The
 * 'choice-needs-user-click' copy ships NOW (B1 seam): plan 3's fillChoice only
 * has to RETURN the reason for the hint to render.
 */
export const REASON_HINT: Record<string, string> = {
  'choice-needs-user-click': 'Select this answer on the page yourself.',
  'other-frame': 'Outside the application frame. Fill puts your value there; nothing is generated or saved for it.',
}

const SEGMENTED_MAX_OPTIONS = 5

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
  /** SOME row is acting. Page writes are serialized globally, so every row's
   *  buttons must look disabled — an enabled button that silently no-ops is the
   *  failure mode this rule removes. */
  locked: boolean
  /** A9: the row belongs to a non-elected frame — manual Fill only. */
  foreign?: boolean
  /** A8: this file row won the resume scoring and is wired to the stored resume. */
  resumeTarget?: boolean
  resumeName?: string | null
  onFillResume?: (ref: string) => void
}

type EditorKind = 'segmented' | 'picker' | 'combobox-empty' | 'file' | 'textarea'

function editorKindOf(row: Row): EditorKind {
  const { field } = row
  if (field.kind === 'file') return 'file'
  if ((field.kind === 'choice' || field.kind === 'radiogroup')
    && field.options.length > 0 && field.options.length <= SEGMENTED_MAX_OPTIONS) return 'segmented'
  if (field.options.length > 0) return 'picker' // >5-option sets, selects, harvested comboboxes
  if (field.kind === 'combobox') return 'combobox-empty'
  return 'textarea'
}

export function FieldRow(p: FieldRowProps) {
  const { row, edited, onEdit, onAccept, onGenerate, onFill, generating, filled, acting, locked } = p
  const { field, resolution, ref } = row
  const label = field.label ?? '(unlabelled field)'
  const value = edited ?? resolution.value ?? ''
  const rowClass = `${ROW_BASE} ${TIER_ACCENT[resolution.tier]}`
  const hint = REASON_HINT[resolution.reason]

  if (resolution.tier === 'skipped') {
    return (
      <li className={rowClass} data-jff-tier="skipped">
        <div className="flex items-baseline gap-1.5"><span className="font-semibold">{label}</span></div>
        <p className={`mt-1 text-[12px] ${MUTED}`}>Demographic question. Never auto-filled.</p>
      </li>
    )
  }

  const editor = editorKindOf(row)

  return (
    <li className={rowClass} data-jff-tier={resolution.tier}>
      <div className="flex items-baseline gap-1.5">
        <label className="font-semibold" htmlFor={`f-${ref}`}>{label}</label>
        {field.required && <span className="text-red-600 dark:text-red-400" title="required">*</span>}
        <span
          data-jff-tier-badge="1"
          className={`rounded-full border border-neutral-200 px-1.5 text-[11px] dark:border-neutral-700 ${MUTED}`}
        >
          {TIER_BADGE[resolution.tier]}
        </span>
        {p.foreign === true && (
          <span data-jff-frame-badge="1" className={`rounded-full border border-amber-300 px-1.5 text-[11px] dark:border-amber-600 ${MUTED}`}>
            frame {field.frameId}
          </span>
        )}
        {resolution.source !== null && (
          <span className={`ml-auto rounded-full border border-neutral-200 px-1.5 text-[11px] dark:border-neutral-700 ${MUTED}`}>
            {SOURCE_BADGE[resolution.source]}
          </span>
        )}
      </div>

      {field.description !== undefined && field.description !== '' && (
        <p data-jff-description="1" className={`mt-0.5 text-[12px] ${MUTED}`}>{field.description}</p>
      )}

      {editor === 'segmented' && (
        <div className="mt-1.5 flex flex-wrap gap-1" role="group" data-jff-editor="segmented">
          {field.options.map((opt) => (
            <button
              key={opt} type="button" aria-pressed={value === opt}
              className={`${BTN} ${value === opt ? 'border-blue-600 font-semibold text-blue-700 dark:border-blue-400 dark:text-blue-300' : ''}`}
              onClick={() => onEdit(ref, opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {editor === 'picker' && (
        <>
          <input
            id={`f-${ref}`} data-jff-editor="picker" list={`opts-${ref}`}
            className={`${INPUT} mt-1.5`} value={value}
            onChange={(e) => onEdit(ref, e.target.value)}
          />
          <datalist id={`opts-${ref}`}>
            {field.options.map((o) => <option key={o} value={o} />)}
          </datalist>
        </>
      )}

      {editor === 'combobox-empty' && (
        <>
          <input
            id={`f-${ref}`} data-jff-editor="combobox-empty"
            className={`${INPUT} mt-1.5`} value={value}
            onChange={(e) => onEdit(ref, e.target.value)}
          />
          <p className={`mt-1 text-[12px] ${MUTED}`}>dropdown — options load on fill</p>
        </>
      )}

      {editor === 'file' && (p.resumeTarget === true
        ? (
            <div className="mt-1.5 flex items-center gap-2" data-jff-editor="resume">
              <span className={MUTED}>{p.resumeName ?? '(no resume stored)'}</span>
              <button
                type="button" className={BTN_PRIMARY}
                disabled={p.resumeName == null || locked || acting !== null}
                onClick={() => p.onFillResume?.(ref)}
              >
                {busyLabel(acting === 'fill', 'Put on page', 'Uploading…')}
              </button>
              {filled && <span className={`text-[11px] ${MUTED}`}>on the page</span>}
            </div>
          )
        : (
            // Two identical resume buttons would reintroduce the autofill-pane
            // trap: every non-winning file row is manual-only, with its score.
            <p className={`mt-1 text-[12px] ${MUTED}`} data-jff-editor="file">
              File field — resume score {scoreResumeField(field)}. Set it on the page yourself.
            </p>
          ))}

      {editor === 'textarea' && (
        <textarea
          id={`f-${ref}`}
          className={`${INPUT} mt-1.5 resize-y`}
          rows={value.length > 90 ? 4 : 1}
          value={value}
          onChange={(e) => onEdit(ref, e.target.value)}
        />
      )}

      {hint !== undefined && <p className={`mt-1 text-[12px] ${MUTED}`} data-jff-hint="1">{hint}</p>}

      {editor !== 'file' && (
        <div className="mt-1.5 flex items-center gap-2">
          {resolution.tier === 'proposed' && (
            // Accept both fills the page AND confirms the mapping (App.onAccept).
            <button type="button" className={BTN_PRIMARY} disabled={locked || acting !== null} onClick={() => onAccept(ref)}>
              {busyLabel(acting === 'accept', 'Accept', 'Accepting…')}
            </button>
          )}
          {resolution.tier === 'needs_input' && (
            <>
              {/* A9: a foreign row has no resolution the host ever saw, so there
                  is nothing to generate against — manual Fill is all it gets. */}
              {p.foreign !== true && (
                <button type="button" className={BTN} disabled={generating || locked || acting !== null} onClick={() => onGenerate(ref)}>
                  {generating ? 'Drafting…' : 'Generate with AI'}
                </button>
              )}
              {/* Closes the spec's loop: generate, edit, then put it on the page.
                  Unlike Accept this confirms NO mapping: a needs-input row has no
                  key the LLM proposed, only an answer the user wrote. */}
              <button type="button" className={BTN_PRIMARY} disabled={value.trim() === '' || locked || acting !== null} onClick={() => onFill(ref)}>
                {busyLabel(acting === 'fill', 'Fill', 'Filling…')}
              </button>
              {filled && <span className={`text-[11px] ${MUTED}`}>on the page</span>}
            </>
          )}
          <span className={`ml-auto font-mono text-[11px] ${MUTED}`} title={resolution.reason}>{resolution.reason}</span>
        </div>
      )}
    </li>
  )
}
