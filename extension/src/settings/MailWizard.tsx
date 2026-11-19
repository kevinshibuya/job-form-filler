import { useEffect, useState } from 'react'
import type { MailStatus } from '@jff/shared'
import { createHostPort, type HostPort } from '../panel/port'
import { ConnectSteps } from './ConnectSteps'
import { asksProjectId, CONSOLE_STEPS, stepLink, type ConsoleStep } from './consoleSteps'
import { loadWizard, saveWizard, type WizardState } from './wizardStore'
import { CARD, CODE, H_SECTION, LINK_BUTTON, MUTED, TEXT_ACTION, FIELD } from './look'

/** Text with `code spans`, as the research document writes it. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? <code key={i} className={CODE}>{part}</code> : <span key={i}>{part}</span>)}
    </>
  )
}

/** The done mark: the reference's on/off switch, blue only when on. */
function DoneSwitch({ on, title, onToggle }: { on: boolean; title: string; onToggle: () => void }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={`Done: ${title}`} onClick={onToggle}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-0 p-0 transition-colors ${
        on ? 'bg-blue-600 dark:bg-blue-500' : 'bg-neutral-300 dark:bg-neutral-600'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
  }
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <code className={`${CODE} min-w-0 break-all`}>{value}</code>
      <button type="button" className={TEXT_ACTION} aria-label={`Copy ${value}`} onClick={() => { void copy() }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </li>
  )
}

function StepCard({ step, state, onProjectId, onToggle }: {
  step: ConsoleStep
  state: WizardState
  onProjectId: (id: string) => void
  onToggle: () => void
}) {
  const link = stepLink(step, state.projectId)
  const done = state.done.includes(step.n)
  return (
    <li className={`${CARD} px-5 py-4`} data-jff-step={step.n} data-jff-done={done ? '1' : '0'}>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[15px] font-medium">{step.n}. {step.title}</h3>
          <p className={`mt-1 mb-0 ${MUTED}`}>Paste: <Prose text={step.paste} /></p>
        </div>
        <div className="flex shrink-0 items-center gap-4 pt-0.5">
          {link !== null && (
            <a className={LINK_BUTTON} href={link} target="_blank" rel="noreferrer">Open in Google Cloud</a>
          )}
          {link === null && step.link !== null && (
            <span className={`max-w-40 text-right text-[12px] ${MUTED}`}>Type your Project ID in step 1 first.</span>
          )}
          <DoneSwitch on={done} title={step.title} onToggle={onToggle} />
        </div>
      </div>
      {step.values.length > 0 && (
        <ul
          className="mt-3 mb-0 list-none divide-y divide-neutral-200 rounded-lg border border-neutral-200 p-0 dark:divide-neutral-800 dark:border-neutral-800"
          data-jff-paste="1"
        >
          {step.values.map((v) => <CopyRow key={v} value={v} />)}
        </ul>
      )}
      {asksProjectId(step) && (
        <label className={`mt-3 block ${MUTED}`}>
          <span className="mb-1 block">Project ID</span>
          <input
            className={`${FIELD} max-w-xs text-neutral-900 dark:text-neutral-100`} value={state.projectId}
            spellCheck={false} autoComplete="off" onChange={(e) => onProjectId(e.target.value)}
          />
        </label>
      )}
      <p className={`mt-3 mb-0 text-[12px] ${MUTED}`}>Done when: <Prose text={step.doneWhen} /></p>
    </li>
  )
}

/**
 * The Mail section with no Mail account: the steps that create the user's own
 * Google client in the Cloud console, one card each, in the research
 * document's order. It starts from the Onboarding view (a heading, one muted
 * sentence, then the inputs) laid out in the settings page's groups. It links
 * to the console and stops there: nothing here acts on Google's pages. Its
 * last two steps take the downloaded client file and Connect.
 */
export function MailWizard({ port = createHostPort, onConnected = () => {} }: {
  /** The Native host, asked for only when Connect is clicked. */
  port?: () => HostPort
  onConnected?: (status: MailStatus) => void
} = {}) {
  const [state, setState] = useState<WizardState | null>(null)

  useEffect(() => {
    let live = true
    void loadWizard().then((s) => { if (live) setState(s) })
    return () => { live = false }
  }, [])

  /** Every change is the user's, and each one is written as it happens. */
  const change = (next: WizardState): void => {
    setState(next)
    void saveWizard(next)
  }

  const toggle = (s: WizardState, n: number): void => change({
    ...s, done: s.done.includes(n) ? s.done.filter((d) => d !== n) : [...s.done, n].sort((a, b) => a - b),
  })

  return (
    <section data-jff-wizard="1" {...(state === null ? {} : { 'data-jff-wizard-loaded': '1' })}>
      <h2 className={H_SECTION}>Create your Google client</h2>
      <p className={`mt-0 mb-4 ${MUTED}`}>
        The tool sends mail through your own Gmail, with a Google client you create yourself in the Google Cloud console.
        Each step opens the console page it needs. Mark a step done when the console shows what it says, and the page keeps
        your place.
      </p>
      {state !== null && (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {CONSOLE_STEPS.map((step) => (
            <StepCard
              key={step.n} step={step} state={state}
              onProjectId={(projectId) => change({ ...state, projectId })}
              onToggle={() => toggle(state, step.n)}
            />
          ))}
          <ConnectSteps first={CONSOLE_STEPS.length + 1} port={port} onConnected={onConnected} />
        </ol>
      )}
    </section>
  )
}
