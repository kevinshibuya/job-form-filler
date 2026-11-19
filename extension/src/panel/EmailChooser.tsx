import { useEffect, useState, type ReactNode } from 'react'
import { isAddressShape, type AddressContext, type ApplyAddressCandidate, type ApplyAddressChoice } from '@jff/shared'
import type { AddressPickUi } from './applyAddressPick'
import { BTN, BTN_PRIMARY, INPUT, MUTED, ROW_BASE } from './ui'

/**
 * The email flow of the Side panel (spec #66), the one module the main
 * component mounts for it. This ticket builds the choice of the Apply
 * address: the page's candidates listed with the places the page shows them,
 * a box to type an address, and the To row once one is chosen, with the
 * Application email's rows below it.
 *
 * The candidate rows start from the Field rows (`ROW_BASE`, the bold first
 * line, the muted detail), and the boxes from the panel's text inputs.
 */

export const NOT_AN_ADDRESS = 'That is not an email address. It needs one @ and a domain, as in jobs@example.org.'

const CHOSEN_COPY: Record<ApplyAddressChoice, string> = {
  pick: 'Picked from the page\'s addresses',
  list: 'Chosen from the page\'s addresses',
  typed: 'Typed by you',
}

export interface EmailChooserProps {
  candidates: ApplyAddressCandidate[]
  applyAddress: string | null
  chosenBy: ApplyAddressChoice | null
  /** The page has Fields: the flow waits behind "Apply by email instead". */
  hasFields: boolean
  /** The Apply address pick: out, or ended without an address. */
  pick: AddressPickUi | null
  /** "Apply by email instead" was clicked: the pick may run now. */
  onOffer: () => void
  /** A shape-checked address the user picked from the list or typed. */
  onChoose: (address: string, how: 'list' | 'typed') => void
  /** The Application email's rows, shown under the To row. As a function it
   *  is told whether the To box holds an edit not yet taken: empty, refused by
   *  the shape check, or not yet committed. */
  review?: ReactNode | ((toPending: boolean) => ReactNode)
}

function ContextLine({ context }: { context: AddressContext }) {
  if (context.kind === 'text') return <li className="break-words"><q>{context.sentence}</q></li>
  return (
    <li className="break-words">
      Link “{context.linkText || '(no text)'}”
      {context.subject !== null && <> · subject “{context.subject}”</>}
    </li>
  )
}

/** The box an address is typed into, with its shape check. */
function TypedBox({ onChoose }: { onChoose: (address: string) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (): void => {
    const address = value.trim()
    if (!isAddressShape(address)) { setError(NOT_AN_ADDRESS); return }
    setError(null)
    onChoose(address)
  }
  return (
    <div className={`mt-2 block ${MUTED}`} data-jff-email-typed="1">
      <label className="block">
        Type the address to apply to
        <input
          className={`${INPUT} mt-1`} type="email" value={value} placeholder="jobs@example.org"
          onChange={(e) => { setValue(e.target.value); setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        />
      </label>
      <button type="button" className={`${BTN} mt-1`} onClick={submit}>Use this address</button>
      {error !== null && <p className="mt-1 text-red-600 dark:text-red-400" role="alert" data-jff-email-error="1">{error}</p>}
    </div>
  )
}

/** The chosen Apply address, editable under the same shape check. */
function ToRow({ address, chosenBy, onChoose, onPending }: {
  address: string; chosenBy: ApplyAddressChoice | null; onChoose: (address: string) => void
  /** Whether the box differs from the chosen address. */
  onPending: (pending: boolean) => void
}) {
  const [value, setValue] = useState(address)
  const [error, setError] = useState<string | null>(null)
  // A choice made elsewhere (the list) replaces what the box shows.
  useEffect(() => { setValue(address); setError(null) }, [address])
  useEffect(() => { onPending(value.trim() !== address) }, [value, address])
  const commit = (): void => {
    const next = value.trim()
    if (next === address) { setError(null); return }
    if (!isAddressShape(next)) { setError(NOT_AN_ADDRESS); return }
    setError(null)
    onChoose(next)
  }
  return (
    <div className={`${ROW_BASE} border-l-blue-600 dark:border-l-blue-400`} data-jff-email-to="1">
      <label className="block">
        <span className="font-semibold">To</span>
        <input
          className={`${INPUT} mt-1`} type="email" value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        />
      </label>
      {chosenBy !== null && <p className={`mt-1 text-[12px] ${MUTED}`} data-jff-email-chosen={chosenBy}>{CHOSEN_COPY[chosenBy]}</p>}
      {error !== null && <p className="mt-1 text-[12px] text-red-600 dark:text-red-400" role="alert" data-jff-email-error="1">{error}</p>}
    </div>
  )
}

/** What the pick says while no Apply address is chosen. The candidates and
 *  the box stay below it throughout, so the user can choose without waiting. */
function PickLine({ pick }: { pick: AddressPickUi }) {
  if (pick.kind === 'picking') {
    return <p className={`mt-2 text-[12px] ${MUTED}`} role="status" data-jff-email-pick="picking">Choosing the address to apply to from the page's addresses…</p>
  }
  if (pick.kind === 'none') {
    return (
      <p className="mt-2 text-[12px] text-amber-600 dark:text-amber-400" data-jff-email-pick="none">
        No address on this page is clearly the one for applications. Choose one below, or type it.
      </p>
    )
  }
  return (
    <p className="mt-2 whitespace-pre-line text-[12px] text-red-600 dark:text-red-400" role="alert" data-jff-email-pick="failed">
      {`Could not pick the address. ${pick.reason}\nChoose one below, or type it.`}
    </p>
  )
}

export function EmailChooser({ candidates, applyAddress, chosenBy, hasFields, pick, onOffer, onChoose, review }: EmailChooserProps) {
  const [toPending, setToPending] = useState(false)
  // Beside a form the flow waits for a click, which sends nothing. A chosen
  // address opens it for good: it is stored with the Session.
  const [offerTaken, setOfferTaken] = useState(false)
  const [typing, setTyping] = useState(false)
  const open = !hasFields || offerTaken || applyAddress !== null

  if (!open) {
    if (candidates.length === 0) return null
    return (
      <div className="mt-3" data-jff-email="1">
        <button type="button" className={`${BTN} ${MUTED}`} data-jff-email-offer="1" onClick={() => { setOfferTaken(true); onOffer() }}>
          Apply by email instead
        </button>
      </div>
    )
  }

  const unchosen = candidates.length === 0 && applyAddress === null
  return (
    <section className="mt-4" data-jff-email="1">
      {pick !== null && applyAddress === null && <PickLine pick={pick} />}
      {applyAddress !== null && (
        <>
          <ToRow address={applyAddress} chosenBy={chosenBy} onChoose={(a) => onChoose(a, 'typed')} onPending={setToPending} />
          {typeof review === 'function' ? review(toPending) : review}
        </>
      )}
      {candidates.length > 0 && (
        <>
          <p className={`mb-1 mt-3 text-[11px] font-semibold uppercase tracking-widest ${MUTED}`}>Addresses on this page</p>
          <ul className="m-0 grid list-none gap-2 p-0" data-jff-candidates="1">
            {candidates.map((c) => {
              const chosen = applyAddress !== null && c.address.toLowerCase() === applyAddress.toLowerCase()
              return (
                <li
                  key={c.address} data-jff-candidate={c.address}
                  className={`${ROW_BASE} ${chosen ? 'border-l-blue-600 dark:border-l-blue-400' : 'border-l-neutral-300 dark:border-l-neutral-600'}`}
                >
                  <div className="flex items-baseline gap-1.5"><span className="font-semibold break-all">{c.address}</span></div>
                  <ul className={`m-0 mt-1 list-none p-0 text-[12px] ${MUTED}`}>
                    {c.contexts.map((ctx, i) => <ContextLine key={i} context={ctx} />)}
                  </ul>
                  <div className="mt-1.5">
                    <button type="button" className={BTN_PRIMARY} disabled={chosen} onClick={() => onChoose(c.address, 'list')}>
                      {chosen ? 'Chosen' : 'Use this address'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {unchosen && !typing
        ? <button type="button" className={`${BTN} mt-2`} onClick={() => setTyping(true)}>Type an Apply address</button>
        : applyAddress === null && <TypedBox onChoose={(a) => onChoose(a, 'typed')} />}
    </section>
  )
}
