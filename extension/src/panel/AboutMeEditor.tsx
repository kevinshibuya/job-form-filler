import { useState } from 'react'
import { ABOUT_ME_MAX } from '@jff/shared'
import { BTN_PRIMARY, INPUT, MUTED, busyLabel } from './ui'

const count = (n: number): string => n.toLocaleString('en-US')

/**
 * About me (spec #98): one text the user writes about themselves for what no
 * Known key holds, such as their availability or the tools they prefer.
 * Generation reads it as fact about the user. It sits beside the Profile
 * editor and follows its pattern: a labelled control, the problem said beside
 * it, and a save only on the user's click, held while the text could not be
 * stored. It is optional: Onboarding never asks for it.
 */
export function AboutMeEditor({
  text, loaded, onSave,
}: {
  /** The stored text, empty for none. The mount-time seed: App remounts this
   *  component once the text arrives, as it does the Profile editor. */
  text: string
  /** False until `aboutMe.get` has answered. */
  loaded: boolean
  /** Stores the text; resolves true when the host stored it. */
  onSave: (text: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState(text)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const over = draft.length > ABOUT_ME_MAX
  const canSave = loaded && !over && !saving

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    try {
      setSaved(await onSave(draft))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mt-4" data-jff-about-me="1">
      <div className="mb-2 grid gap-0.5">
        <label className="text-[13px] font-semibold" htmlFor="about-me">About me</label>
        <p className={`text-[12px] ${MUTED}`}>
          What no fact above holds, such as your availability or the tools you prefer. Drafts read it as true about you.
        </p>
        <textarea
          id="about-me" className={`${INPUT} resize-y`} rows={6} value={draft}
          onChange={(e) => { setDraft(e.target.value); setSaved(false) }}
        />
        <p className={`text-[12px] ${over ? 'text-amber-700 dark:text-amber-400' : MUTED}`} data-jff-about-me-count="1">
          {count(draft.length)} / {count(ABOUT_ME_MAX)} characters
        </p>
        {over && (
          <p className="text-[12px] text-amber-700 dark:text-amber-400" data-jff-about-me-problem="1">
            About me holds at most {count(ABOUT_ME_MAX)} characters. Shorten it to save.
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={!canSave} onClick={() => { void submit() }}>
          {busyLabel(saving, 'Save About me', 'Saving…')}
        </button>
        {saved && <span className={`text-[12px] ${MUTED}`}>Saved.</span>}
      </div>
      {!loaded && <p className={`mt-1.5 text-[12px] ${MUTED}`}>Loading your About me…</p>}
    </section>
  )
}
