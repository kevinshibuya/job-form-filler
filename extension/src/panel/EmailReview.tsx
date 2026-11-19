import { useEffect, useRef, useState } from 'react'
import { EMAIL_INSTRUCTION_MAX, EMAIL_LANGUAGES, type EmailLanguage, type EmailLinkKey, type MailSendersResult, type MailStatus } from '@jff/shared'
import { DraftWarning } from './FieldRow'
import { redraftNeedsConfirm, type EmailDraftUi, type RedraftAsk, type SessionEmailDraft } from './emailDraft'
import { mailHandoverOf, mailtoAddress, type SessionMailHandover } from './mailApp'
import { senderLabel, senderOf } from './senderAddress'
import { BTN, BTN_PRIMARY, INPUT, MUTED, ROW_BASE } from './ui'

/**
 * Review of the Application email (spec #66): the rows under the To row for
 * the subject, the body and the attachment. They extend the Field rows
 * (`ROW_BASE`, the bold label, the muted detail), and a flagged sentence
 * shows with the same warning a Prose Field's Draft carries. Under the body,
 * Regenerate and the language switch ask for a new Draft (ticket #73); with
 * hand edits in the subject or the body they ask first. Where Send will be,
 * "Open in my mail app" hands the email to the user's mail app (ticket #75).
 * The Review asks for the Mail account when it opens; with none, Connect sits
 * beside it and opens the settings page (ticket #80). Nothing about the Draft
 * waits for that answer. With a connected account the Review also asks for
 * its Sender addresses and shows the Sender address row; when the sign-in
 * died, Reconnect stands where Send will be and the Draft stays as it is
 * (ticket #81).
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
  /** The To row's address, the Session's Apply address. */
  to: string | null
  /** "Open in my mail app" was clicked since the Session began. */
  handedOver: boolean
  /** The user opened the mail app with this email. The link opens the
   *  address itself; this records what it carried. */
  onOpenMailApp: (email: SessionMailHandover) => void
  onSubject: (subject: string) => void
  onBody: (body: string) => void
  /** Start the Draft by hand: after a failure, or when nothing started it. */
  onDraft: () => void
  /** Ask for a new Draft in place of the one shown. Called after the user
   *  confirmed losing their edits, when there are any. */
  onRedraft: (ask: RedraftAsk) => void
  /** Asks the Native host for the Mail account: null when it could not say. */
  readMailStatus: () => Promise<MailStatus | null>
  /** Opens the settings page, or focuses it when it is open. */
  onConnect: () => void
  /** Asks the Native host for the Sender addresses: `needs_reconnect` when
   *  Google refused the sign-in, null when it could not say. */
  readSenders: () => Promise<MailSendersResult | 'needs_reconnect' | null>
  /** The Session's chosen Sender address, or null while none was chosen. */
  senderAddress: string | null
  onSender: (address: string) => void
  /** Reconnect: opens the settings page, where the sign-in runs again. */
  onReconnect: () => void
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

/**
 * "Open in my mail app", with the note that the mail app gets no Resume. A
 * link while the email can be handed over, so the browser opens the
 * `mailto:` address on the click; a disabled button while the Draft is being
 * written or checked, or the To address, the subject or the body is empty.
 * It marks nothing: Mark applied stays the user's click.
 */
function MailApp({ email, resumeName, handedOver, onOpen, onConnect, reconnect }: {
  email: SessionMailHandover | null; resumeName: string | null; handedOver: boolean; onOpen: (email: SessionMailHandover) => void
  /** Set when there is no Mail account: Connect shows beside the action. */
  onConnect: (() => void) | null
  /** Set when the account's sign-in died: Reconnect shows where Send will be. */
  reconnect: { address: string; onReconnect: () => void } | null
}) {
  return (
    <div className={ROW} data-jff-email-send="1">
      <div className="flex flex-wrap items-center gap-2">
        {email === null
          ? <button type="button" className={BTN_PRIMARY} disabled data-jff-email-mailapp="1">Open in my mail app</button>
          : (
              <a
                className={`${BTN_PRIMARY} inline-block no-underline`} href={mailtoAddress(email)} target="_blank" rel="noreferrer"
                data-jff-email-mailapp="1" onClick={() => onOpen(email)}
              >
                Open in my mail app
              </a>
            )}
        {onConnect !== null && (
          <button type="button" className={BTN} data-jff-email-connect="1" onClick={onConnect}>Connect</button>
        )}
        {reconnect !== null && (
          <button type="button" className={BTN} data-jff-email-reconnect="1" onClick={reconnect.onReconnect}>Reconnect</button>
        )}
      </div>
      {reconnect !== null && (
        <p className="mt-1 text-[12px] text-amber-600 dark:text-amber-400" role="status" data-jff-email-reconnect-note="1">
          {'The sign-in to '}<span className="break-all font-semibold">{reconnect.address}</span>
          {' has expired or was revoked. Reconnect signs in again in the settings page, and this Draft stays here as it is.'}
        </p>
      )}
      {onConnect !== null && (
        <p className={`mt-1 text-[12px] ${MUTED}`} data-jff-email-connect-note="1">
          Connect a Gmail account in the settings page to send from here with your Resume attached.
        </p>
      )}
      <p className={`mt-1 text-[12px] ${MUTED}`} data-jff-email-mailapp-note="1">
        {'Your mail app gets the address, the subject and the body, but not the Resume. '}
        {resumeName === null ? 'Attach your Resume there before you send.' : <>Attach <span className="break-all font-semibold">{resumeName}</span> there before you send.</>}
      </p>
      {handedOver && (
        <p className={`mt-1 text-[12px] ${MUTED}`} role="status" data-jff-email-handed="1">
          Once it has left your mail app, click Mark applied to record it.
        </p>
      )}
    </div>
  )
}

/**
 * The Mail account and, while it is connected, its Sender addresses: asked
 * for when the Review opens and again when the panel gets the focus back, as
 * it does after a Connect or a Reconnect in the settings page. A list that
 * finds the sign-in dead turns the account to "needs reconnect" here, as the
 * Native host has turned it.
 */
function useMailAccount(
  readStatus: () => Promise<MailStatus | null>,
  readSenders: () => Promise<MailSendersResult | 'needs_reconnect' | null>,
): { mail: MailStatus | null; senders: MailSendersResult | null } {
  const [mail, setMail] = useState<MailStatus | null>(null)
  const [senders, setSenders] = useState<MailSendersResult | null>(null)
  // The reads are fresh closures on every render of the panel; the latest ones ask.
  const reads = useRef({ readStatus, readSenders })
  reads.current = { readStatus, readSenders }
  useEffect(() => {
    let live = true
    const ask = async (): Promise<void> => {
      const s = await reads.current.readStatus()
      if (!live || s === null) return
      setMail(s)
      if (s.state !== 'connected') { setSenders(null); return }
      const list = await reads.current.readSenders()
      if (!live) return
      if (list === 'needs_reconnect') {
        setMail({ ...s, state: 'needs_reconnect' })
        setSenders(null)
      } else if (list !== null) setSenders(list)
    }
    const onFocus = (): void => { void ask().catch(() => {}) }
    onFocus()
    window.addEventListener('focus', onFocus)
    return () => { live = false; window.removeEventListener('focus', onFocus) }
  }, [])
  return { mail, senders }
}

/**
 * The Sender address row (ticket #81): a dropdown of the addresses the
 * account may send as, each with its display name; with one address, that
 * address alone. It shows the Session's choice while the list holds it, else
 * the last used Sender address, else the account's own address.
 */
function SenderRow({ list, choice, onSender }: { list: MailSendersResult; choice: string | null; onSender: (address: string) => void }) {
  const shown = senderOf(list, choice)
  const only = list.senders.length === 1 ? list.senders[0]! : null
  return (
    <div className={ROW} data-jff-email-sender="1">
      {only !== null
        ? (
            <>
              <span className="font-semibold">Sender address</span>
              <p className="mt-1 break-all">{senderLabel(only)}</p>
            </>
          )
        : (
            <label className="block">
              <span className="font-semibold">Sender address</span>
              <select className={`${INPUT} mt-1`} value={shown} onChange={(e) => onSender(e.target.value)}>
                {list.senders.map((s) => <option key={s.address} value={s.address}>{senderLabel(s)}</option>)}
              </select>
            </label>
          )}
    </div>
  )
}

export function EmailReview({
  draft, ui, needsJobText, resumeName, to, handedOver, onOpenMailApp, onSubject, onBody, onDraft, onRedraft, readMailStatus, onConnect,
  readSenders, senderAddress, onSender, onReconnect,
}: EmailReviewProps) {
  const { mail, senders } = useMailAccount(readMailStatus, readSenders)
  if (draft === null) return <NoDraft ui={ui} needsJobText={needsJobText} onDraft={onDraft} />
  // While a new Draft is written, the one shown takes no edit it would lose.
  const busy = ui?.kind === 'drafting'
  // A flagged sentence the user has since edited away is no longer shown.
  const claims = draft.unsupportedClaims.filter((c) => draft.body.includes(c))
  return (
    <div className="mt-2 grid gap-2" data-jff-email-review="1">
      {mail?.state === 'connected' && senders !== null && <SenderRow list={senders} choice={senderAddress} onSender={onSender} />}
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
      <MailApp
        email={busy ? null : mailHandoverOf({ applyAddress: to, emailDraft: draft })}
        resumeName={resumeName} handedOver={handedOver} onOpen={onOpenMailApp}
        onConnect={mail?.state === 'none' ? onConnect : null}
        reconnect={mail?.state === 'needs_reconnect' ? { address: mail.address, onReconnect } : null}
      />
    </div>
  )
}
