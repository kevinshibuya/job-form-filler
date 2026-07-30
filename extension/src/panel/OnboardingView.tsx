import { useState, type ChangeEvent } from 'react'
import { ANSWER_BANK_KEYS, PROFILE_KEYS } from '@jff/shared'
import { profileCompleteness, REQUIRED_FACTS } from './completeness'
import { FactFields } from './ProfileEditor'
import { BTN_PRIMARY, MUTED } from './ui'

/** Every key any REQUIRED_FACTS alternative mentions gets the * marker. */
const REQUIRED_MARKED: ReadonlySet<string> = new Set(REQUIRED_FACTS.flat(2))

/**
 * O2: the hard gate's front door. Upload CV → auto-extract pre-fills EMPTY
 * fields (non-PDF stores the blob, user types) → review all 18 keys with the
 * core ones marked → Finish persists and unlocks scanning. ProfileEditor stays
 * the post-onboarding edit path; the rendering is shared via FactFields.
 */
export function OnboardingView({ values, loaded, resumeName, onUpload, onExtract, onFinish }: {
  values: Record<string, string>
  loaded: boolean
  resumeName: string | null
  onUpload: (file: File) => Promise<string | null>
  onExtract: (cvText: string) => Promise<Record<string, string> | null>
  onFinish: (profile: Record<string, string>, bank: Record<string, string>) => Promise<void>
}) {
  const [draft, setDraft] = useState<Record<string, string>>(values)
  const [busy, setBusy] = useState<'upload' | 'finish' | null>(null)
  const complete = profileCompleteness(draft, resumeName !== null, loaded) === 'complete'

  const set = (k: string, v: string): void => setDraft((d) => ({ ...d, [k]: v }))

  const pick = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (file === undefined || busy !== null) return
    setBusy('upload')
    try {
      const cvText = await onUpload(file)
      // O2: a non-PDF stores the blob but skips auto-extract — the user types.
      if (cvText === null) return
      const facts = await onExtract(cvText)
      if (facts === null) return
      // Pre-fill EMPTY fields only; typed values always win (same rule as
      // ProfileEditor's "Generate from CV", spec D5).
      setDraft((d) => {
        const next = { ...d }
        for (const [k, v] of Object.entries(facts)) {
          if ((next[k] ?? '').trim() === '') next[k] = v
        }
        return next
      })
    } finally {
      setBusy(null)
    }
  }

  const collect = (keys: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const k of keys) {
      const v = draft[k] ?? ''
      // Same rule as ProfileEditor: a key never loaded is omitted, so finishing
      // a partially-loaded editor can never wipe a stored fact.
      if (v !== '' || k in values) out[k] = v
    }
    return out
  }

  const finish = async (): Promise<void> => {
    if (!complete || busy !== null) return
    setBusy('finish')
    try { await onFinish(collect(PROFILE_KEYS), collect(ANSWER_BANK_KEYS)) } finally { setBusy(null) }
  }

  return (
    <section className="mt-3" data-jff-onboarding="1">
      <h2 className="mb-0.5 text-[13px] font-semibold">Welcome — set up your profile</h2>
      <p className={`mb-2.5 ${MUTED}`}>
        Scanning stays locked until the basics every application needs are stored: your resume, name, email and phone.
      </p>
      <label className={`my-2 block ${MUTED}`} data-jff-ob-resume="1">
        Resume {resumeName === null ? '(none stored) *' : `(${resumeName})`}
        <input
          type="file"
          accept=".pdf,.doc,.docx,.txt,.rtf"
          onChange={(e) => { void pick(e) }}
          className="mt-1 block w-full text-[12px] file:mr-2 file:cursor-pointer file:rounded-md file:border file:border-neutral-300 file:bg-transparent file:px-2 file:py-1 file:text-[12px] file:text-inherit dark:file:border-neutral-600"
        />
      </label>
      {busy === 'upload' && <p className={MUTED}>Reading your CV…</p>}
      <FactFields draft={draft} onChange={set} required={REQUIRED_MARKED} idPrefix="ob" />
      <p className={`mb-1.5 text-[12px] ${MUTED}`}>* required to finish setup</p>
      <button
        type="button" className={BTN_PRIMARY} data-jff-ob-finish="1"
        disabled={!complete || busy !== null || !loaded}
        onClick={() => { void finish() }}
      >
        {busy === 'finish' ? 'Saving…' : 'Finish setup'}
      </button>
      {!complete && <p className={`mt-1.5 text-[12px] ${MUTED}`}>Add a resume, your name, email and phone to finish.</p>}
    </section>
  )
}
