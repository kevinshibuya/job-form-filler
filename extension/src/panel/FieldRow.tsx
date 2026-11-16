import type { EnumField, FieldKey, ResolutionTier } from '@jff/shared'
import { VALUE_TYPE_OF, norm, storedValue, yesNoOf } from '@jff/shared'
import { CheckboxGroupEditor, ConsentTick } from './CheckboxGroupRow'
import { offersGeneration } from './generationOffer'
import { SOURCE_BADGE, type Row } from './group'
import { scoreResumeField } from './resumeTarget'
import { OPTION_PICK, OPTION_PICK_FAILED } from './optionPick'
import { MAPPING_LOST } from './scan'
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
  'combobox-no-listbox': 'Open this dropdown on the page yourself and pick the value.',
  // Widget-agnostic on purpose: this reason is shared by combobox, select and
  // radio-group no-match failures (review fix, minors item 16). A row whose
  // Options are known says NO_MATCH_PICK_HINT instead.
  'no-matching-option': 'No option matches this value. Try different text.',
  // The verified commit (spec #6, D1 and D2): the menu stayed open or the page
  // dropped the Option, and a menu another Control left open would not close.
  'no-commit': 'The page did not keep the option. Pick it on the page yourself.',
  'listbox-left-open': 'Another dropdown on the page stayed open. Close it, then Fill again.',
  // The country selector beside a phone box (#30): the phone box is left as it was.
  'phone-country-no-match': 'No country beside the phone box matches your number. Pick it on the page, then type the number.',
  'phone-country-not-set': 'The page did not keep the country beside the phone box. Pick it on the page, then type the number.',
  'phone-country-unknown': 'Your number\'s country code is not one the tool knows. Pick the country on the page, then type the number.',
  [MAPPING_LOST]: 'Matching did not finish. Answer this yourself, or Scan again.',
  // Ticket #29: questions answered for the country they name.
  'names-region': 'The question names a region, not countries. Answer it yourself.',
  'no-country-named': 'The question names no country. This is the answer for your own country.',
  // Ticket #31: the model picked one of the page's Options after a Fill missed (ADR 0008).
  [OPTION_PICK]: 'The model picked this option for your stored answer. Accept it or pick another.',
  [OPTION_PICK_FAILED]: 'None of the page\'s options matches this value, and the model pick failed. Pick one.',
}

/**
 * A yes or a no answered for the country a question names is not the Value of
 * its key: `workAuth` is a list of countries, `sponsorshipNeeded` stores
 * nothing, and a residence question's yes is not a country. Such a row never
 * offers to store what it holds.
 */
function answersPerCountry(key: FieldKey, value: string): boolean {
  return key === 'workAuth' || key === 'sponsorshipNeeded' || (VALUE_TYPE_OF[key] === 'place' && yesNoOf(value) !== null)
}

/** A Fill that found no matching Option on a row whose Options are known: the picker is right below. */
export const NO_MATCH_PICK_HINT = 'None of the page\'s options matches this value. Pick one.'

/** Under a Personal-fact row: why it offers no Generation. */
export const PERSONAL_FACT_HINT = 'A question about you. Answer it yourself.'

const SEGMENTED_MAX_OPTIONS = 5

/** The same mark on every row kind, Skipped included, so the user sees what is still theirs to answer. */
function RequiredMark() {
  return <span className="text-red-600 dark:text-red-400" title="required">*</span>
}

/**
 * A Field the first Resolution step left for Mapping, while Mapping runs.
 * Waiting is not a Resolution outcome, so the row carries no tier and no tier
 * badge. Its actions show, disabled, until the row takes its Resolution: what
 * a click would do depends on what Mapping decides. Every kind of Field, a
 * checkbox group and a Consent checkbox included, waits the same way.
 */
export function WaitingRow({ field }: { field: EnumField }) {
  const hold = 'Still being matched'
  return (
    <li className={`${ROW_BASE} border-l-neutral-300 dark:border-l-neutral-600`} data-jff-waiting="1">
      <div className="flex items-baseline gap-1.5">
        <span className="font-semibold">{field.label ?? '(unlabelled field)'}</span>
        {field.required && <RequiredMark />}
      </div>
      <p className={`mt-1 text-[12px] ${MUTED}`}>Still being matched…</p>
      <div className="mt-1.5 flex items-center gap-2">
        <button type="button" className={BTN_PRIMARY} disabled title={hold}>Accept</button>
        <button type="button" className={BTN} disabled title={hold}>Generate with AI</button>
        <button type="button" className={BTN_PRIMARY} disabled title={hold}>Fill</button>
      </div>
    </li>
  )
}

export interface FieldRowProps {
  row: Row
  edited: string | null
  onEdit: (ref: string, value: string) => void
  onAccept: (ref: string) => void
  onGenerate: (ref: string) => void
  /** Puts the row's current value on the page WITHOUT accepting it as a mapping. */
  onFill: (ref: string) => void
  /** Stores the row's fact under its key. Only ever offered on a keyed row. */
  onSaveFact: (ref: string) => void
  generating: boolean
  filled: boolean
  /** Which of this row's page-writing actions is in flight, if any. */
  acting: 'accept' | 'fill' | 'save_fact' | null
  /** SOME row is acting. Page writes are serialized globally, so every row's
   *  buttons must look disabled — an enabled button that silently no-ops is the
   *  failure mode this rule removes. */
  locked: boolean
  /** The stored facts, and whether they have actually arrived. Both matter: until
   *  the load lands every key looks absent, and offering "Save to profile" in that
   *  window would let one click overwrite a stored fact with a page value. */
  facts: Record<string, string>
  factsReady: boolean
  /** What this row holds ON THE PAGE, when the page has its own value. The editor
   *  above shows the panel's value; a fact the user picked or typed on the page
   *  lives only in the session snapshot, and that is the value a save stores. */
  pageValue?: string | null
  /** A9: the row belongs to a non-elected frame — manual Fill only. */
  foreign?: boolean
  /** A8: this file row won the resume scoring and is wired to the stored resume. */
  resumeTarget?: boolean
  resumeName?: string | null
  onFillResume?: (ref: string) => void
  /** The sentences of this row's Draft the Draft check found unsupported by the
   *  user's own material. Shown above the editor; none means no warning. */
  unsupportedClaims?: string[]
}

/**
 * Above a Draft the Draft check flagged: each sentence that states something
 * about the user which nothing they stored supports, quoted so they can find
 * and fix it in the editor below. The Draft itself stays editable (ADR 0004).
 */
function DraftWarning({ claims }: { claims: string[] }) {
  return (
    <div
      role="note" data-jff-draft-warning="1"
      className="mt-1.5 rounded-md border border-amber-300 px-2 py-1.5 text-[12px] text-amber-800 dark:border-amber-600 dark:text-amber-300"
    >
      <p>Nothing you stored supports {claims.length === 1 ? 'this sentence' : 'these sentences'}. Check {claims.length === 1 ? 'it' : 'them'} before you fill:</p>
      <ul className="mt-1 space-y-0.5">
        {claims.map((c) => <li key={c}><q>{c}</q></li>)}
      </ul>
    </div>
  )
}

type EditorKind = 'segmented' | 'picker' | 'combobox-empty' | 'file' | 'textarea' | 'checkboxes' | 'consent'

function editorKindOf(row: Row): EditorKind {
  const { field } = row
  if (field.kind === 'file') return 'file'
  if (field.kind === 'checkboxgroup') return 'checkboxes'
  if (field.kind === 'checkbox') return 'consent'
  if ((field.kind === 'choice' || field.kind === 'radiogroup')
    && field.options.length > 0 && field.options.length <= SEGMENTED_MAX_OPTIONS) return 'segmented'
  if (field.options.length > 0) return 'picker' // >5-option sets, selects, dropdowns a Fill has read
  if (field.kind === 'combobox') return 'combobox-empty'
  return 'textarea'
}

export function FieldRow(p: FieldRowProps) {
  const { row, edited, onEdit, onAccept, onGenerate, onFill, onSaveFact, generating, filled, acting, locked } = p
  const { field, resolution, ref } = row
  const label = field.label ?? '(unlabelled field)'
  const value = edited ?? resolution.value ?? ''
  // The host quotes each claim exactly as the Draft had it. Once an edit takes
  // a sentence out, its warning goes with it: a warning never quotes words the
  // user cannot find in the row.
  const claims = (p.unsupportedClaims ?? []).filter((c) => value.includes(c))
  // A keyed row IS a fact, so it is never generated. It offers "Save to profile"
  // instead, but only when nothing is stored under the key yet: a page-sourced
  // email that an ATS autofilled must not overwrite the stored one on one click.
  const keyed = resolution.key !== null
  const backedByStore = resolution.source === 'profile'
    || resolution.source === 'answer_bank'
    || resolution.source === 'llm_key'
  // Old text of a typed key is no Value (shared/src/typedValues.ts), so the
  // row still offers to store one.
  const alreadyStored = resolution.key !== null && storedValue(resolution.key, (p.facts[resolution.key] ?? '').trim()) !== null
  // The value a save would actually store: page beats panel edit beats engine,
  // the same precedence buildSaveItems and App.onSaveFact use. Reading `value`
  // here would disable the button for every row the user answered on the page.
  const factValue = (p.pageValue ?? edited ?? resolution.value ?? '').trim()
  const canSaveFact = keyed && p.factsReady && !backedByStore && !alreadyStored
    && !answersPerCountry(resolution.key!, factValue)
  const rowClass = `${ROW_BASE} ${TIER_ACCENT[resolution.tier]}`
  // A Needs input row that is not a Prose Field asks about the user, unless it
  // already says why it is theirs (a failed Mapping, a failed Fill).
  const personalFact = resolution.tier === 'needs_input' && resolution.fieldClass === 'personal_fact'
  const hint = resolution.reason === 'no-matching-option' && field.options.length > 0
    ? NO_MATCH_PICK_HINT
    : REASON_HINT[resolution.reason] ?? (personalFact ? PERSONAL_FACT_HINT : undefined)

  if (resolution.tier === 'skipped') {
    return (
      <li className={rowClass} data-jff-tier="skipped">
        <div className="flex items-baseline gap-1.5">
          <span className="font-semibold">{label}</span>
          {field.required && <RequiredMark />}
        </div>
        <p className={`mt-1 text-[12px] ${MUTED}`}>Demographic question. Never auto-filled.</p>
      </li>
    )
  }

  const editor = editorKindOf(row)

  return (
    <li className={rowClass} data-jff-tier={resolution.tier}>
      <div className="flex items-baseline gap-1.5">
        <label className="font-semibold" id={`l-${ref}`} htmlFor={`f-${ref}`}>{label}</label>
        {field.required && <RequiredMark />}
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

      {claims.length > 0 && <DraftWarning claims={claims} />}

      {resolution.standsFor !== undefined && resolution.tier !== 'needs_input' && (
        <p data-jff-stands-for="1" className={`mt-0.5 line-clamp-3 text-[12px] ${MUTED}`}>
          Stands for your stored answer: <span className="font-medium">{resolution.standsFor}</span>
        </p>
      )}

      {editor === 'checkboxes' && (
        <CheckboxGroupEditor
          options={field.options} value={value} labelledBy={`l-${ref}`}
          onChange={(v) => onEdit(ref, v)}
        />
      )}

      {editor === 'consent' && <ConsentTick id={`f-${ref}`} value={value} onChange={(v) => onEdit(ref, v)} />}

      {editor === 'segmented' && (
        <div className="mt-1.5 flex flex-wrap gap-1" role="group" data-jff-editor="segmented">
          {field.options.map((opt) => {
            // B5d: the same normalization the fill engine uses — a value that
            // FILLS as 'Yes' must HIGHLIGHT as 'Yes'.
            const selected = norm(value) === norm(opt)
            return (
              <button
                key={opt} type="button" aria-pressed={selected}
                className={`${BTN} ${selected ? 'border-blue-600 font-semibold text-blue-700 dark:border-blue-400 dark:text-blue-300' : ''}`}
                onClick={() => onEdit(ref, opt)}
              >
                {opt}
              </button>
            )
          })}
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
          {/* First control in the container: for a needs_input row it lands before
              Fill, and for a page-sourced or saved_answer row (tier 'auto') it is
              the only control that row has ever had. */}
          {canSaveFact && (
            <button
              type="button" data-jff-save-fact="1" className={BTN}
              disabled={factValue === '' || locked || acting !== null}
              onClick={() => onSaveFact(ref)}
            >
              {busyLabel(acting === 'save_fact', 'Save to profile', 'Saving…')}
            </button>
          )}
          {resolution.tier === 'proposed' && (
            // Accept both fills the page AND confirms the mapping (App.onAccept).
            <button type="button" className={BTN_PRIMARY} disabled={locked || acting !== null} onClick={() => onAccept(ref)}>
              {busyLabel(acting === 'accept', 'Accept', 'Accepting…')}
            </button>
          )}
          {resolution.tier === 'needs_input' && (
            <>
              {/* A9: a foreign row has no resolution the host ever saw, so there
                  is nothing to generate against — manual Fill is all it gets.
                  Otherwise only a Prose Field on a text Control is drafted. */}
              {p.foreign !== true && offersGeneration(row) && (
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
