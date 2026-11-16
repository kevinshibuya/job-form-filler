import { useState } from 'react'
import {
  ANSWER_BANK_KEYS, PROFILE_KEYS, displayValue, isFieldKey, isOldText, phoneProposal, refusalOf, toStoredText,
} from '@jff/shared'
import { BTN, BTN_PRIMARY, INPUT, MUTED } from './ui'
import { WorkAuthEditor } from './WorkAuthEditor'

const FACT_LABELS: Record<string, string> = {
  firstName: 'First name', lastName: 'Last name', fullName: 'Full name',
  preferredName: 'Preferred name', email: 'Email', phone: 'Phone',
  location: 'Current location', city: 'City', region: 'State or region', country: 'Country',
  linkedin: 'LinkedIn URL', github: 'GitHub URL', portfolio: 'Portfolio URL',
  currentCompany: 'Current company', currentTitle: 'Current title', workAuth: 'Work authorization',
  relocate: 'Willing to relocate', salary: 'Salary expectation', notice: 'Notice period',
  earliestStart: 'Earliest start date', remotePreference: 'Remote preference', pronouns: 'Pronouns',
}

/**
 * The keys the editor asks for. `sponsorshipNeeded` is not one: its answer is
 * worked out from `workAuth` for the country a question names, and nothing is
 * stored for it.
 */
const EDITED_KEYS = [...PROFILE_KEYS, ...ANSWER_BANK_KEYS].filter((k) => k !== 'sponsorshipNeeded')

/** What a write would store for one draft entry: a typed key's canonical form, or null when refused. */
function storedText(key: string, value: string): string | null {
  if (!isFieldKey(key)) return value
  const r = toStoredText(key, value)
  return r.ok ? r.text : null
}

/**
 * The facts being edited, shared by ProfileEditor and OnboardingView. A typed
 * key whose loaded text is old text (shared/src/typedValues.ts) has no Value:
 * its box starts empty and the old text becomes its hint. Old text stays
 * stored until the user enters a Value, so a save never sends that key empty.
 */
export function useFactDraft(values: Record<string, string>) {
  const [state, setState] = useState(() => {
    const draft: Record<string, string> = {}
    const hints: Record<string, string> = {}
    for (const [k, v] of Object.entries(values)) {
      if (isFieldKey(k) && isOldText(k, v)) hints[k] = v
      else draft[k] = v
    }
    return { draft, hints }
  })
  const { draft, hints } = state

  const set = (k: string, v: string): void => setState((s) => ({ ...s, draft: { ...s.draft, [k]: v } }))

  /** Resume facts go into EMPTY keys only: the user's typing always wins, and a
   *  typed key's text that is not a Value becomes its hint, as old text does. */
  const merge = (facts: Record<string, string>): void => setState((s) => {
    const next = { draft: { ...s.draft }, hints: { ...s.hints } }
    for (const [k, v] of Object.entries(facts)) {
      if ((next.draft[k] ?? '').trim() !== '') continue
      if (isFieldKey(k) && isOldText(k, v)) next.hints[k] = v
      else next.draft[k] = v
    }
    return next
  })

  /** Keys whose draft a write would refuse, with the reason said beside them. */
  const problems: Record<string, string> = {}
  for (const [k, v] of Object.entries(draft)) {
    const refusal = isFieldKey(k) ? refusalOf(k) : null
    if (refusal !== null && storedText(k, v) === null) problems[k] = `${FACT_LABELS[k] ?? k} ${refusal}.`
  }

  /** The draft as a write would store it; a refused entry counts as empty. */
  const stored: Record<string, string> = {}
  for (const [k, v] of Object.entries(draft)) stored[k] = storedText(k, v) ?? ''

  const collect = (keys: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const k of keys) {
      const v = stored[k] ?? ''
      // A key is sent when it has a value, or when it was LOADED and the user
      // cleared it (the host deletes on ''). A key we never loaded is omitted, so
      // saving a partially-loaded editor can never wipe a stored fact; nor is a
      // key whose loaded text is old text and still has no Value.
      if (v === '' && isFieldKey(k) && isOldText(k, values[k])) continue
      if (v !== '' || k in values) out[k] = v
    }
    return out
  }

  return { draft, hints, problems, stored, set, merge, collect }
}

export type FactDraft = ReturnType<typeof useFactDraft>

/** The yes/no control: unset until the user chooses, its words formatted from the Value. */
function YesNoSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <select id={id} className={INPUT} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Not set</option>
      <option value="yes">{displayValue('relocate', 'yes')}</option>
      <option value="no">{displayValue('relocate', 'no')}</option>
    </select>
  )
}

/** O2: the one fact-grid renderer OnboardingView and ProfileEditor share.
 *  `required` renders the * marker; `idPrefix` keeps ids unique across views. */
export function FactFields({ facts, required = null, idPrefix = 'p' }: {
  facts: FactDraft
  required?: ReadonlySet<string> | null
  idPrefix?: string
}) {
  const { draft, hints, problems, set } = facts
  // The one proposal the editor makes by itself: the old phone in international
  // form, behind the calling code of the country in the form. Offered until the
  // phone box holds a Value; nothing is stored until the user confirms it.
  const phoneHint = hints['phone']
  const proposal = phoneHint === undefined || (facts.stored['phone'] ?? '') !== ''
    ? null
    : phoneProposal(phoneHint, draft['country'] ?? null)
  return (
    <>
      {EDITED_KEYS.map((k) => {
        const id = `${idPrefix}-${k}`
        return (
          <div className="mb-2 grid gap-0.5" key={k}>
            <label className={`text-[12px] ${MUTED}`} htmlFor={id}>
              {FACT_LABELS[k] ?? k}
              {required?.has(k) === true && <span aria-hidden="true"> *</span>}
            </label>
            {k === 'relocate'
              ? <YesNoSelect id={id} value={draft[k] ?? ''} onChange={(v) => set(k, v)} />
              : k === 'workAuth'
                ? <WorkAuthEditor id={id} value={draft[k] ?? ''} onChange={(v) => set(k, v)} />
                : <input id={id} className={INPUT} value={draft[k] ?? ''} onChange={(e) => set(k, e.target.value)} />}
            {hints[k] !== undefined && (
              <p className={`text-[12px] ${MUTED}`} data-jff-fact-hint={k}>Old entry, not used until you enter a new one: {hints[k]}</p>
            )}
            {k === 'phone' && proposal !== null && (
              <button type="button" className={`${BTN} justify-self-start`} data-jff-phone-proposal="1" onClick={() => set('phone', proposal)}>
                Use {proposal}
              </button>
            )}
            {problems[k] !== undefined && (
              <p className="text-[12px] text-amber-700 dark:text-amber-400" data-jff-fact-problem={k}>{problems[k]}</p>
            )}
          </div>
        )
      })}
    </>
  )
}

export function ProfileEditor({
  values, loaded, onSave, onExtract = null,
}: {
  /** Facts fetched from the host. Arrives asynchronously; may be partial. */
  values: Record<string, string>
  /** False until profile.get AND answerBank.get have both answered. */
  loaded: boolean
  onSave: (profile: Record<string, string>, bank: Record<string, string>) => void
  /** B6: null when no stored resume text exists — the button renders disabled.
   *  Resolves null on a failed extraction (host error already surfaced by App). */
  onExtract?: (() => Promise<Record<string, string> | null>) | null
}) {
  // `values` is the mount-time seed. App remounts this component (via `key`) the
  // moment the facts arrive, so the draft can never be stuck on a pre-load snapshot.
  const facts = useFactDraft(values)
  // A value the host would refuse holds the save here, named beside its key,
  // so a save never fails on it.
  const canSave = loaded && Object.keys(facts.problems).length === 0

  const submit = (): void => {
    if (!canSave) return
    onSave(facts.collect(PROFILE_KEYS), facts.collect(ANSWER_BANK_KEYS))
  }

  const [extracting, setExtracting] = useState(false)
  const runExtract = async (): Promise<void> => {
    if (onExtract === null || extracting) return
    setExtracting(true)
    try {
      const extracted = await onExtract()
      // Merge into EMPTY draft fields only, and nothing persists until they
      // press Save facts (spec D5).
      if (extracted !== null) facts.merge(extracted)
    } finally {
      setExtracting(false)
    }
  }

  return (
    <section className="mt-3" data-jff-editor="1">
      <h2 className="mb-0.5 text-[13px] font-semibold">Your facts</h2>
      <p className={`mb-2.5 ${MUTED}`}>These are the only values the tool will ever put on a page.</p>
      <FactFields facts={facts} />
      <div className="flex items-center gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={!canSave} onClick={submit}>Save facts</button>
        <button
          type="button" className={BTN}
          disabled={onExtract === null || extracting}
          title={onExtract === null ? 'Store a PDF resume first' : undefined}
          onClick={runExtract}
        >
          {extracting ? 'Extracting…' : 'Generate from CV'}
        </button>
      </div>
      {!loaded && <p className={`mt-1.5 text-[12px] ${MUTED}`}>Loading your saved facts…</p>}
    </section>
  )
}
