import { useState } from 'react'
import { EMAIL_INSTRUCTION_MAX, EMAIL_LANGUAGES, type EmailLanguage, type EmailLinkKey } from '@jff/shared'
import { DraftWarning } from './FieldRow'
import { redraftNeedsConfirm, type EmailDraftUi, type RedraftAsk, type SessionEmailDraft } from './emailDraft'
import { BTN, BTN_PRIMARY, INPUT, MUTED, ROW_BASE } from './ui'

/**
 * Review of the Application email (spec #66): the rows under the To row for
 * the subject, the body and the attachment. They extend the Field rows
 * (`ROW_BASE`, the bold label, the muted detail), and a flagged sentence
 * shows with the same warning a Prose Field's Draft carries. Under the body,
 * Regenerate and the language switch ask for a new Draft (ticket #73); with
 * hand edits in the subject or the body they ask first.
 */

const LINK_NAME: Record<EmailLinkKey, string> = { linkedin: 'LinkedIn', github: 'GitHub', portfolio: 'portfolio' }

const ROW = `${ROW_BASE} border-l-blue-600 dark:border-l-blue-400`

const LANGUAGE_NAME: Record<EmailLanguage, string> = { en: 'English', pt: 'Portuguese' }

export interface EmailReviewProps {
  draft: SessionEmailDraft | null
  /** The Draft is out, or failed, while the Session holds none. */
  ui: EmailDraftUi | null
  /** No Draft can start: the Session holds no Job posting text. */
  needsJobText: boolean
  resumeName: string | null
  onSubject: (subject: string) => void
  onBody: (body: string) => void
  /** Start the Draft by hand: after a failure, or when nothing started it. */
  onDraft: () => void
  /** Ask for a new Draft in place of the one shown. Called after the user
   *  confirmed losing their edits, when there are any. */
  onRedraft: (ask: RedraftAsk) => void
}

function NoDraft({ ui, needsJobText, onDraft }: Pick<EmailReviewProps, 'ui' | 'needsJobText' | 'onDraft'>) {
  if (ui?.kind === 'drafting') {
    return <p className={`mt-2 text-[12px] ${MUTED}`} role="status" data-jff-email-draft="drafting">Writing the Application email…</p>
  }
  if (needsJobText) {
    return (
      <p className="mt-2 text-[12px] text-amber-600 dark:text-amber-400" data-jff-email-needs-jobtext="1">
        The Application email needs the job description. Paste it in the box above, or click Pick job description and click it on the page.
      </p>
    )
  }
  if (ui?.kind === 'failed') {
    return (
      <div className="mt-2" data-jff-email-draft="failed">
        <p className="whitespace-pre-line text-[12px] text-red-600 dark:text-red-400" role="alert">{`Could not write the Application email. ${ui.reason}`}</p>
        <button type="button" className={`${BTN} mt-1`} onClick={onDraft}>Try again</button>
      </div>
    )
  }
  return (
    <div className="mt-2">
      <button type="button" className={BTN_PRIMARY} onClick={onDraft}>Write the Application email</button>
    </div>
  )
}

/**
 * Regenerate, its instruction and the language switch. A new Draft asked for
 * over hand edits waits for the user to confirm; declining sends nothing.
 */
function Redraft({ draft, ui, onRedraft }: { draft: SessionEmailDraft; ui: EmailDraftUi | null; onRedraft: (ask: RedraftAsk) => void }) {
  const [instruction, setInstruction] = useState('')
  const [pending, setPending] = useState<RedraftAsk | null>(null)
  const busy = ui?.kind === 'drafting'
  const ask = (a: RedraftAsk): void => {
    if (busy) return
    if (redraftNeedsConfirm(draft)) setPending(a)
    else onRedraft(a)
  }
  const replaced = draft.edited
    ? 'A new Draft replaces your edits to the body.'
    : 'A new Draft replaces the body.'
  return (
    <div className={ROW} data-jff-email-regenerate="1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Language</span>
        <div role="group" aria-label="Language" className="flex gap-1" data-jff-email-language={draft.language}>
          {EMAIL_LANGUAGES.map((l) => (
            <button
              key={l} type="button" className={BTN} aria-pressed={draft.language === l} disabled={busy}
              onClick={() => { if (l !== draft.language) ask({ language: l, instruction: '' }) }}
            >
              {LANGUAGE_NAME[l]}
            </button>
          ))}
        </div>
      </div>
      <label className="mt-2 block">
        <span className={`text-[12px] ${MUTED}`}>Instruction for a new Draft (optional)</span>
        <input
          className={`${INPUT} mt-1`} value={instruction} maxLength={EMAIL_INSTRUCTION_MAX}
          placeholder="shorter, or lead with the payments work"
          onChange={(e) => setInstruction(e.target.value.slice(0, EMAIL_INSTRUCTION_MAX))}
        />
      </label>
      <button type="button" className={`${BTN} mt-1`} disabled={busy} onClick={() => ask({ language: draft.language, instruction })}>
        Regenerate
      </button>
      {pending !== null && (
        <div className="mt-2 rounded-md border border-amber-300 px-2 py-1.5 text-[12px] dark:border-amber-600" role="alertdialog" aria-label="Replace your edits?" data-jff-email-confirm="1">
          <p className="text-amber-800 dark:text-amber-300">
            {replaced}
            {draft.subjectEdited && ' Your edited subject stays.'}
          </p>
          <div className="mt-1 flex gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={() => { setPending(null); onRedraft(pending) }}>Write a new Draft</button>
            <button type="button" className={BTN} onClick={() => setPending(null)}>Keep my edits</button>
          </div>
        </div>
      )}
      {busy && <p className={`mt-2 text-[12px] ${MUTED}`} role="status" data-jff-email-draft="redrafting">Writing a new Draft…</p>}
      {ui?.kind === 'failed' && (
        <p className="mt-2 whitespace-pre-line text-[12px] text-red-600 dark:text-red-400" role="alert" data-jff-email-draft="failed">
          {`Could not write a new Draft. ${ui.reason}`}
        </p>
      )}
    </div>
  )
}

export function EmailReview({ draft, ui, needsJobText, resumeName, onSubject, onBody, onDraft, onRedraft }: EmailReviewProps) {
  if (draft === null) return <NoDraft ui={ui} needsJobText={needsJobText} onDraft={onDraft} />
  // While a new Draft is written, the one shown takes no edit it would lose.
  const busy = ui?.kind === 'drafting'
  // A flagged sentence the user has since edited away is no longer shown.
  const claims = draft.unsupportedClaims.filter((c) => draft.body.includes(c))
  return (
    <div className="mt-2 grid gap-2" data-jff-email-review="1">
      <div className={ROW} data-jff-email-subject="1">
        <label className="block">
          <span className="font-semibold">Subject</span>
          <input className={`${INPUT} mt-1`} value={draft.subject} readOnly={busy} onChange={(e) => onSubject(e.target.value)} />
        </label>
        {draft.pageSubject !== null && draft.subject === draft.pageSubject && (
          <p className={`mt-1 text-[12px] ${MUTED}`}>The subject the page asks for</p>
        )}
      </div>
      <div className={ROW} data-jff-email-body="1">
        <label className="block">
          <span className="font-semibold">Body</span>
          <textarea className={`${INPUT} mt-1 resize-y`} rows={12} value={draft.body} readOnly={busy} onChange={(e) => onBody(e.target.value)} />
        </label>
        <p className={`mt-1 text-[12px] ${MUTED}`} data-jff-email-model="1">
          Drafted by {draft.model}
          {draft.edited && <span data-jff-email-edited="1"> · edited by you</span>}
        </p>
        {draft.unchecked && (
          <p
            role="note" data-jff-email-unchecked="1"
            className="mt-1.5 rounded-md border border-amber-300 px-2 py-1.5 text-[12px] text-amber-800 dark:border-amber-600 dark:text-amber-300"
          >
            The Draft check did not run, so nothing compared this Draft with your Profile and Resume. Read it closely before you send.
          </p>
        )}
        {claims.length > 0 && <DraftWarning claims={claims} before="send" />}
        {draft.missingLinks.map((key) => (
          <p
            key={key} data-jff-email-missing-link={key}
            className="mt-1.5 rounded-md border border-amber-300 px-2 py-1.5 text-[12px] text-amber-800 dark:border-amber-600 dark:text-amber-300"
          >
            The posting asks for your {LINK_NAME[key]} link, and your Profile holds none, so the body leaves it out. Add it before you send.
          </p>
        ))}
      </div>
      <Redraft draft={draft} ui={ui} onRedraft={onRedraft} />
      <div className={ROW} data-jff-email-attachment="1">
        <span className="font-semibold">Attachment</span>
        <p className={`mt-1 break-all ${resumeName === null ? 'text-amber-600 dark:text-amber-400' : ''}`}>
          {resumeName ?? 'No Resume stored. Add one above.'}
        </p>
      </div>
    </div>
  )
}
