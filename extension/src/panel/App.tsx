import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { ContentMessage, EnumField, Resolution, SelfCheck } from '@jff/shared'
import { SNAPSHOT_KEY_RE } from '../snapshotKey'
import { BANNER_BASE, BANNER_BAD, SelfCheckBanner } from './Banner'
import { guessCompany } from './company'
import { FieldRow } from './FieldRow'
import { groupRows, refOf, type Row } from './group'
import { createHostPort, ERROR_COPY, type HostPort } from './port'
import { ProfileEditor } from './ProfileEditor'
import { loadResume, saveResume } from './resume'
import { runScan, type FrameReply } from './scan'
import { createTabScope } from './tabScope'
import { BTN, BTN_PRIMARY, INPUT, MUTED } from './ui'

export function App() {
  const portRef = useRef<HostPort | null>(null)
  const [check, setCheck] = useState<SelfCheck | null>(null)
  const [hostError, setHostError] = useState<string | null>(null)
  const [tabId, setTabId] = useState<number | null>(null)
  // Bumped ONLY when the bound tab navigated. Task 20 Step 9 makes this the
  // re-scan trigger; a tab switch or close must clear state without re-scanning.
  const [scanNonce, setScanNonce] = useState(0)
  const [resetCount, setResetCount] = useState(0)
  const [fields, setFields] = useState<EnumField[]>([])
  const [resolutions, setResolutions] = useState<Resolution[]>([])
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [generatingRef, setGeneratingRef] = useState<string | null>(null)
  const [filledRefs, setFilledRefs] = useState<readonly string[]>([])
  const [jobText, setJobText] = useState('')
  const [company, setCompany] = useState('')
  const [unreachable, setUnreachable] = useState(0)
  const [activeCaptcha, setActiveCaptcha] = useState(false)
  const [showEditor, setShowEditor] = useState(false)
  const [facts, setFacts] = useState<Record<string, string>>({})
  // The editor must not be savable before profile.get/answerBank.get answer: the
  // host DELETES a key written as '' (Task 5 writeKv).
  const [factsLoaded, setFactsLoaded] = useState(false)
  const [resumeName, setResumeName] = useState<string | null>(null)
  // Seeded from the clock, not 0. storage.session snapshot rows outlive a panel
  // instance, so a fresh panel restarting at epoch 1 on the same tab would happily
  // merge a PREVIOUS application's snapshot into this application's save, attributing
  // old answers to new fids. A per-session base makes that collision impossible.
  const epochRef = useRef(Date.now())
  // Ignore-while-running. The panel auto-scans on open, and the user can also press
  // Scan; two overlapping runScans race, and the loser's fills land under a stale
  // epoch and are rejected, leaving fields half-filled nondeterministically.
  const scanningRef = useRef(false)

  const groups = groupRows(fields, resolutions)
  const companyOrNull = company.trim() === '' ? null : company.trim()

  /* ------------------------------------------------------------- lifecycle */

  useEffect(() => {
    const port = createHostPort()
    portRef.current = port
    port.onDisconnect(() => setHostError(ERROR_COPY.unreachable))
    void port.request<SelfCheck>('selfCheck', {}).then((r) => {
      if (r.ok) setCheck(r.result)
      else setHostError(ERROR_COPY[r.error.kind])
    })
    return () => port.disconnect()
  }, [])

  /** Everything a scan produced. Cleared on ANY tab-scope reset; only a navigation
   *  additionally re-scans. All the setters are stable, so closing over this once
   *  from the bind effect is safe. */
  const resetScanState = (): void => {
    setFields([]); setResolutions([]); setEdits({}); setFilledRefs([])
    setUnreachable(0); setActiveCaptcha(false); setJobText('')
  }

  useEffect(() => {
    let stop: (() => void) | null = null
    // Unmounting before tabs.query resolves would otherwise register listeners
    // that nothing ever removes.
    let cancelled = false
    const bind = (id: number | null): void => {
      if (cancelled) return
      setTabId(id)
      if (id === null) return
      stop = createTabScope(id, (reason) => {
        setResetCount((n) => n + 1)
        resetScanState()
        // Only a navigation is a new page. Re-scanning on every tab ACTIVATION would
        // spend one batched `claude -p` resolve per tab switch, and on a tab CLOSE the
        // scan would run against a tab that no longer exists.
        if (reason === 'navigated') setScanNonce((n) => n + 1)
      })
    }
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => bind(tabs[0]?.id ?? null))
    return () => { cancelled = true; if (stop !== null) stop() }
  }, [])

  useEffect(() => { void loadResume().then((r) => setResumeName(r?.name ?? null)) }, [])

  // Pre-fill the facts editor from the host. `factsLoaded` is what unlocks Save in
  // the ProfileEditor, so the editor is inert until this resolves. Task 20 Step 9
  // lists this same effect: it is ALREADY HERE, so do not add a second copy.
  useEffect(() => {
    const port = portRef.current
    if (port === null) return
    void Promise.all([
      port.request<Record<string, string>>('profile.get', {}),
      port.request<Record<string, string>>('answerBank.get', {}),
    ]).then(([p, b]) => {
      setFacts({ ...(p.ok ? p.result : {}), ...(b.ok ? b.result : {}) })
      setFactsLoaded(true)
    })
  }, [check])

  /* --------------------------------------------------------------- actions */

  const onEdit = (ref: string, value: string): void => setEdits((e) => ({ ...e, [ref]: value }))

  const sendToTab = async (frameId: number | undefined, message: ContentMessage): Promise<FrameReply[]> => {
    const res = await chrome.runtime.sendMessage({ kind: 'toContent', tabId, frameId, message })
    return (res as { replies?: FrameReply[] }).replies ?? []
  }

  /** chrome.tabs.get REJECTS once the bound tab is gone. Every caller here runs
   *  from an event the user does not control, so a raw call is an unhandled
   *  rejection waiting for a tab close. */
  const getTab = async (): Promise<chrome.tabs.Tab | null> => {
    if (tabId === null) return null
    try { return await chrome.tabs.get(tabId) } catch { return null }
  }

  const onScan = async (): Promise<void> => {
    const port = portRef.current
    if (port === null || tabId === null || scanningRef.current) return
    const tab = await getTab()
    if (tab === null) return // tab closed between the trigger and here
    scanningRef.current = true
    try {
      // A previous application on this same tab may have left snapshot rows in
      // storage.session. They must never merge into this scan's save.
      const keys = Object.keys(await chrome.storage.session.get(null))
        .filter((k) => { const m = SNAPSHOT_KEY_RE.exec(k); return m !== null && Number(m[1]) === tabId })
      if (keys.length > 0) await chrome.storage.session.remove(keys)

      const hostname = tab.url === undefined ? '' : new URL(tab.url).hostname
      // Company: the user's edit always wins; guess only while the field is empty.
      const co = companyOrNull ?? guessCompany(tab.title ?? '', hostname)
      if (co !== null && companyOrNull === null) setCompany(co)
      const out = await runScan({
        tabId,
        nextEpoch: () => ++epochRef.current,
        inject: async () => {
          const r = await chrome.runtime.sendMessage({ kind: 'inject', tabId })
          return (r as { frames?: number[] }).frames ?? []
        },
        sendToTab,
        port,
        getResume: loadResume,
        pastedJobText: jobText,
        hostname,
        url: tab.url ?? '',
        company: co,
      })
      setFields(out.fields)
      setResolutions(out.resolutions)
      setUnreachable(out.unreachableWidgets)
      setActiveCaptcha(out.activeCaptcha)
      setEdits({})
      setFilledRefs([])
      if (out.jobText !== '') setJobText(out.jobText)
      if (out.llmError !== null) setHostError(ERROR_COPY[out.llmError.kind])
    } finally {
      scanningRef.current = false
    }
  }

  const onPickJobText = async (): Promise<void> => {
    // Spec's element picker: the user clicks the element holding the job text;
    // the selector is learned per hostname so future scans find it directly.
    // The content script always replies (click, Escape or timeout, Task 17 Step 5).
    if (tabId === null || fields.length === 0) return
    const replies = await sendToTab(0, { type: 'JFF_PICK', epoch: epochRef.current })
    const p = replies[0]?.payload as { ok: boolean; pick?: { selector: string; text: string } } | undefined
    if (p?.ok !== true || p.pick === undefined) return // cancelled or timed out
    setJobText(p.pick.text)
    const tab = await getTab()
    const hostname = tab?.url === undefined ? '' : new URL(tab.url).hostname
    if (hostname !== '') {
      await portRef.current?.request('selector.save', { hostname, purpose: 'job_description', selector: p.pick.selector })
    }
  }

  const onPickResume = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (file === undefined) return
    await saveResume(file)
    setResumeName(file.name)
  }

  // Auto-scan on open and after the bound tab navigates (a wizard step is new DOM).
  // `resetScanState` has already cleared jobText, so this scan can never feed the
  // PREVIOUS page's job description to resolve.
  useEffect(() => { if (tabId !== null) void onScan() }, [tabId, scanNonce])

  /** Put one value on the page. Shared by Accept and Fill; the difference between
   *  them is what they additionally CONFIRM, which is why this is not a component. */
  const fillOne = async (row: Row, value: string): Promise<void> => {
    if (tabId === null || value === '') return
    await chrome.runtime.sendMessage({
      kind: 'toContent', tabId, frameId: row.field.frameId,
      message: { type: 'JFF_FILL', epoch: row.field.epoch, fills: [{ handle: row.resolution.handle, value }] },
    })
  }

  const onAccept = async (ref: string): Promise<void> => {
    const row = groups.proposed.find((r) => r.ref === ref)
    if (row === undefined) return
    const value = edits[ref] ?? row.resolution.value ?? ''
    if (value === '') return
    await fillOne(row, value)
    // Accepting an AI key match IS the user confirmation the spec's learned_mappings
    // flow needs: promote this label to a deterministic mapping.
    if (row.resolution.source === 'llm_key' && row.resolution.key !== null && row.field.label !== null) {
      void portRef.current?.request('mapping.confirm', { label: row.field.label, fieldKey: row.resolution.key })
    }
    // Promote the TIER only. Overwriting resolution.value with the accepted value
    // would make engine === final in buildSaveItems (Task 21) and silently discard
    // every correction the user made to a proposed answer, which is the learning
    // loop's whole point. The edit stays in `edits`, which is exactly where the
    // save diff looks for it.
    setResolutions((rs) => rs.map((r) => (refOf(r.handle) === ref ? { ...r, tier: 'auto' as const } : r)))
  }

  /** The spec's loop ends in a FILL: generate, edit, then put it on the page.
   *  Needs-input rows are never auto-filled and have no mapping to confirm, so this
   *  deliberately does neither mapping.confirm nor a tier promotion. */
  const onFill = async (ref: string): Promise<void> => {
    const row = groups.needs_input.find((r) => r.ref === ref)
    if (row === undefined) return
    const value = edits[ref] ?? row.resolution.value ?? ''
    if (value.trim() === '') return
    await fillOne(row, value)
    setFilledRefs((f) => (f.includes(ref) ? f : [...f, ref]))
  }

  const onGenerate = async (ref: string): Promise<void> => {
    const row = groups.needs_input.find((r) => r.ref === ref)
    const port = portRef.current
    if (row === undefined || port === null) return
    setGeneratingRef(ref)
    const r = await port.request<{ draft: string }>('generate', {
      handle: row.resolution.handle,
      questionRaw: row.field.label ?? '',
      jobText,
      company: companyOrNull,
    })
    setGeneratingRef(null)
    if (r.ok) setEdits((e) => ({ ...e, [ref]: r.result.draft }))
    else setHostError(ERROR_COPY[r.error.kind])
  }

  const onSaveFacts = async (profile: Record<string, string>, bank: Record<string, string>): Promise<void> => {
    const port = portRef.current
    if (port === null) return
    await port.request('profile.set', { values: profile })
    await port.request('answerBank.set', { values: bank })
    // Merge, never replace: the editor omits keys it never loaded, so replacing
    // would drop them from the panel's own view of the facts.
    setFacts((f) => ({ ...f, ...profile, ...bank }))
    setShowEditor(false)
  }

  /* ---------------------------------------------------------------- markup */

  return (
    // The two counters are debug surface, not decoration: they are how a browser
    // smoke tells "the tab scope reset" apart from "the panel re-scanned".
    <main className="p-3" data-jff-ready="1" data-jff-resets={String(resetCount)} data-jff-scans={String(scanNonce)}>
      <header className="flex items-center justify-between border-b border-neutral-200 pb-2 dark:border-neutral-700">
        <h1 className="m-0 text-[13px] font-semibold tracking-wide" data-jff-title="1">job-form-filler</h1>
        <span className="text-neutral-500 tabular-nums dark:text-neutral-400" data-jff-tab={String(tabId ?? '')}>
          {tabId === null ? 'no tab' : `tab ${tabId}`}
        </span>
      </header>

      <SelfCheckBanner check={check} error={hostError} />

      {activeCaptcha && (
        <div className={`${BANNER_BASE} ${BANNER_BAD}`} role="status" data-jff-captcha="1">
          A CAPTCHA challenge is active on this page. Solve it yourself; the extension will not touch it.
        </div>
      )}
      {unreachable > 0 && (
        <p className={`mt-3 ${MUTED}`}>{unreachable} widget(s) use closed shadow roots and cannot be read. Fill those by hand.</p>
      )}

      <div className="my-2.5 flex items-center gap-2" data-jff-actions="1">
        <button type="button" className={BTN_PRIMARY} disabled={tabId === null} onClick={onScan}>Scan</button>
        <button type="button" className={BTN} onClick={() => setShowEditor((s) => !s)}>
          {showEditor ? 'Back to fields' : 'Edit your facts'}
        </button>
      </div>

      <label className={`my-2 block ${MUTED}`} data-jff-resume="1">
        Resume {resumeName === null ? '(none stored)' : `(${resumeName})`}
        <input
          type="file"
          accept=".pdf,.doc,.docx,.txt,.rtf"
          onChange={onPickResume}
          className="mt-1 block w-full text-[12px] file:mr-2 file:cursor-pointer file:rounded-md file:border file:border-neutral-300 file:bg-transparent file:px-2 file:py-1 file:text-[12px] file:text-inherit dark:file:border-neutral-600"
        />
      </label>

      <label className={`my-2 block ${MUTED}`} data-jff-company="1">
        Company
        <input
          className={`${INPUT} mt-1`}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Guessed on scan; edit if wrong"
        />
      </label>

      <label className={`my-2.5 block ${MUTED}`} data-jff-paste="1">
        Job description (paste here if the scan could not find it)
        <textarea className={`${INPUT} mt-1 resize-y`} rows={4} value={jobText} onChange={(e) => setJobText(e.target.value)} />
        <button type="button" className={`${BTN} mt-1`} disabled={fields.length === 0} onClick={onPickJobText}>
          Pick job description
        </button>
      </label>

      {showEditor
        ? (
            // `key` remounts the editor the instant the facts arrive, so an editor
            // opened during the load never stays stuck on an empty snapshot.
            <ProfileEditor key={factsLoaded ? 'loaded' : 'pending'} values={facts} loaded={factsLoaded} onSave={onSaveFacts} />
          )
        : (['needs_input', 'proposed', 'auto', 'skipped'] as const).map((tier) => (
            groups[tier].length === 0 ? null : (
              <section className="mt-4" key={tier} data-jff-group={tier}>
                <h2 className={`m-0 mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest ${MUTED}`}>
                  {tier === 'needs_input' ? 'Needs input' : tier === 'proposed' ? 'Proposed' : tier === 'auto' ? 'Filled' : 'Skipped'}
                  <span className="rounded-full bg-neutral-200 px-1.5 text-[11px] dark:bg-neutral-700">{groups[tier].length}</span>
                </h2>
                <ul className="m-0 grid list-none gap-2 p-0">
                  {groups[tier].map((row) => (
                    <FieldRow
                      key={row.ref} row={row} edited={edits[row.ref] ?? null}
                      onEdit={onEdit} onAccept={onAccept} onGenerate={onGenerate} onFill={onFill}
                      generating={generatingRef === row.ref}
                      filled={filledRefs.includes(row.ref)}
                    />
                  ))}
                </ul>
              </section>
            )
          ))}
    </main>
  )
}
