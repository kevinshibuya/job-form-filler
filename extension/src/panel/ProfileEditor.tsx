import { useState } from 'react'
import { ANSWER_BANK_KEYS, PROFILE_KEYS } from '@jff/shared'
import { BTN_PRIMARY, INPUT, MUTED } from './ui'

const LABELS: Record<string, string> = {
  firstName: 'First name', lastName: 'Last name', fullName: 'Full name',
  preferredName: 'Preferred name', email: 'Email', phone: 'Phone',
  location: 'Current location', linkedin: 'LinkedIn URL', github: 'GitHub URL',
  portfolio: 'Portfolio URL', workAuth: 'Work authorization', sponsorshipNeeded: 'Needs sponsorship',
  relocate: 'Willing to relocate', salary: 'Salary expectation', notice: 'Notice period',
  earliestStart: 'Earliest start date', remotePreference: 'Remote preference', pronouns: 'Pronouns',
}

export function ProfileEditor({
  values, loaded, onSave,
}: {
  /** Facts fetched from the host. Arrives asynchronously; may be partial. */
  values: Record<string, string>
  /** False until profile.get AND answerBank.get have both answered. */
  loaded: boolean
  onSave: (profile: Record<string, string>, bank: Record<string, string>) => void
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

  return (
    <section className="mt-3" data-jff-editor="1">
      <h2 className="mb-0.5 text-[13px] font-semibold">Your facts</h2>
      <p className={`mb-2.5 ${MUTED}`}>These are the only values the tool will ever put on a page.</p>
      {[...PROFILE_KEYS, ...ANSWER_BANK_KEYS].map((k) => (
        <div className="mb-2 grid gap-0.5" key={k}>
          <label className={`text-[12px] ${MUTED}`} htmlFor={`p-${k}`}>{LABELS[k] ?? k}</label>
          <input id={`p-${k}`} className={INPUT} value={draft[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
        </div>
      ))}
      <button type="button" className={BTN_PRIMARY} disabled={!loaded} onClick={submit}>Save facts</button>
      {!loaded && <p className={`mt-1.5 text-[12px] ${MUTED}`}>Loading your saved facts…</p>}
    </section>
  )
}
