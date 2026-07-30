import { useState } from 'react'
import { ANSWER_BANK_KEYS, PROFILE_KEYS } from '@jff/shared'
import { BTN, BTN_PRIMARY, INPUT, MUTED } from './ui'

const FACT_LABELS: Record<string, string> = {
  firstName: 'First name', lastName: 'Last name', fullName: 'Full name',
  preferredName: 'Preferred name', email: 'Email', phone: 'Phone',
  location: 'Current location', linkedin: 'LinkedIn URL', github: 'GitHub URL',
  portfolio: 'Portfolio URL', workAuth: 'Work authorization', sponsorshipNeeded: 'Needs sponsorship',
  relocate: 'Willing to relocate', salary: 'Salary expectation', notice: 'Notice period',
  earliestStart: 'Earliest start date', remotePreference: 'Remote preference', pronouns: 'Pronouns',
}

/** O2: the one fact-grid renderer OnboardingView and ProfileEditor share.
 *  `required` renders the * marker; `idPrefix` keeps ids unique across views. */
export function FactFields({ draft, onChange, required = null, idPrefix = 'p' }: {
  draft: Record<string, string>
  onChange: (key: string, value: string) => void
  required?: ReadonlySet<string> | null
  idPrefix?: string
}) {
  return (
    <>
      {[...PROFILE_KEYS, ...ANSWER_BANK_KEYS].map((k) => (
        <div className="mb-2 grid gap-0.5" key={k}>
          <label className={`text-[12px] ${MUTED}`} htmlFor={`${idPrefix}-${k}`}>
            {FACT_LABELS[k] ?? k}
            {required?.has(k) === true && <span aria-hidden="true"> *</span>}
          </label>
          <input id={`${idPrefix}-${k}`} className={INPUT} value={draft[k] ?? ''} onChange={(e) => onChange(k, e.target.value)} />
        </div>
      ))}
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
  const [draft, setDraft] = useState<Record<string, string>>(values)
  const set = (k: string, v: string): void => setDraft((d) => ({ ...d, [k]: v }))

  const collect = (keys: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const k of keys) {
      const v = draft[k] ?? ''
      // A key is sent when it has a value, or when it was LOADED and the user
      // cleared it (the host deletes on ''). A key we never loaded is omitted, so
      // saving a partially-loaded editor can never wipe a stored fact.
      if (v !== '' || k in values) out[k] = v
    }
    return out
  }

  const submit = (): void => {
    if (!loaded) return
    onSave(collect(PROFILE_KEYS), collect(ANSWER_BANK_KEYS))
  }

  const [extracting, setExtracting] = useState(false)
  const runExtract = async (): Promise<void> => {
    if (onExtract === null || extracting) return
    setExtracting(true)
    try {
      const facts = await onExtract()
      if (facts !== null) {
        // Merge into EMPTY draft fields only — the user's typing always wins,
        // and nothing persists until they press Save facts (spec D5).
        setDraft((d) => {
          const next = { ...d }
          for (const [k, v] of Object.entries(facts)) {
            if ((next[k] ?? '').trim() === '') next[k] = v
          }
          return next
        })
      }
    } finally {
      setExtracting(false)
    }
  }

  return (
    <section className="mt-3" data-jff-editor="1">
      <h2 className="mb-0.5 text-[13px] font-semibold">Your facts</h2>
      <p className={`mb-2.5 ${MUTED}`}>These are the only values the tool will ever put on a page.</p>
      <FactFields draft={draft} onChange={set} />
      <div className="flex items-center gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={!loaded} onClick={submit}>Save facts</button>
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
