import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { ContentMessage, EnumField, FillReport, Resolution, SelfCheck } from '@jff/shared'
import { BANNER_BASE, BANNER_BAD, SelfCheckBanner } from './Banner'
import { guessCompany } from './company'
import { FieldRow } from './FieldRow'
import { groupRows, refOf, type Row } from './group'
import { createHostPort, ERROR_COPY, type HostPort } from './port'
import { ProfileEditor } from './ProfileEditor'
import { loadResume, saveResume } from './resume'
import { runScan, ScanError, type FrameReply, type FrameReport, type RelayFailure, type ScanProgress, type SendResult } from './scan'
import { ScanStatus, type ScanUiState } from './ScanStatus'
import { buildSaveItems, mergeStoredSnapshots, type StoredSnapshot } from './save'
import { createTabScope } from './tabScope'
import { BTN, BTN_PRIMARY, busyLabel, INPUT, MUTED, ROW_BASE } from './ui'
import { SNAPSHOT_KEY_RE } from '../snapshotKey'

/**
 * `chrome.tabs.Tab.url` is `''` — not `undefined` — for a tab that has not committed
 * a navigation yet, and `new URL('')` THROWS. onScan runs from a `void`-ed effect, so
 * that throw surfaces as an unhandled rejection: a console error plus a scan that
 * silently never happens. Any unparseable url just means "no hostname".
 */
export const hostnameOf = (url: string | undefined): string => {
  if (url === undefined || url === '') return ''
  try { return new URL(url).hostname } catch { return '' }
}

/** How long the auto-scan waits for the host's selfCheck before going ahead
 *  anyway. A host that connects but never answers must not pin the panel on
 *  'connecting' forever; the resolve step surfaces the host problem loudly. */
export const HOST_WAIT_MS = 10_000

export interface AppProps {
  /** Injected only by tests, so the gate's timeout is provable without fake timers. */
  hostWaitMs?: number
}

export function App({ hostWaitMs = HOST_WAIT_MS }: AppProps = {}) {
  const portRef = useRef<HostPort | null>(null)
  // Seeded from the clock, not 0: storage.session snapshot rows outlive a panel
  // instance, so a fresh panel restarting at 1 on the same tab could merge a
  // PREVIOUS application's snapshot into this one's save.
  const epochRef = useRef(Date.now())
  // Ignore-while-running guard: the mount auto-scan and a Scan click must not
  // produce two overlapping runScans racing each other's epoch.
  const scanningRef = useRef(false)
  const [check, setCheck] = useState<SelfCheck | null>(null)
  const [hostError, setHostError] = useState<string | null>(null)
  const [tabId, setTabId] = useState<number | null>(null)
  const [resetCount, setResetCount] = useState(0)
  const [scanNonce, setScanNonce] = useState(0)
  const [fields, setFields] = useState<EnumField[]>([])
  const [resolutions, setResolutions] = useState<Resolution[]>([])
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [generatedRefs, setGeneratedRefs] = useState<readonly string[]>([])
  const [filledRefs, setFilledRefs] = useState<readonly string[]>([])
  const [generatingRef, setGeneratingRef] = useState<string | null>(null)
  const [jobText, setJobText] = useState('')
  const [company, setCompany] = useState('')
  const [unreachable, setUnreachable] = useState(0)
  const [activeCaptcha, setActiveCaptcha] = useState(false)
  const [showEditor, setShowEditor] = useState(false)
  const [facts, setFacts] = useState<Record<string, string>>({})
  const [factsLoaded, setFactsLoaded] = useState(false)
  const [resumeName, setResumeName] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<Record<string, string>>({})
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [reuseOverrides, setReuseOverrides] = useState<Record<string, 'reusable' | 'company_specific'>>({})
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState<ScanUiState | null>(null)
  const [frameReports, setFrameReports] = useState<FrameReport[]>([])
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [acting, setActing] = useState<{ ref: string; action: 'accept' | 'fill' } | null>(null)
  const [gateOpen, setGateOpen] = useState(false)

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

  /** Everything a scan produced. Cleared on ANY tab-scope reset. All setters are
   *  stable, so the bind effect below may close over this once. */
  const resetScanState = (): void => {
    setFields([]); setResolutions([]); setEdits({}); setFilledRefs([]); setGeneratedRefs([])
    setSnapshot({}); setUnreachable(0); setActiveCaptcha(false); setJobText(''); setSaveMsg(null)
    setReuseOverrides({})
    setScanStatus(null); setFrameReports([])
  }

  useEffect(() => {
    let stop: (() => void) | null = null
    // Unmounting before tabs.query resolves would otherwise leak listeners that
    // nothing ever removes.
    let cancelled = false
    // ?tabId= lets the e2e smoke drive the panel as an ordinary page; the real
    // side panel binds to the active tab.
    const override = new URLSearchParams(location.search).get('tabId')
    const bind = (id: number | null): void => {
      if (cancelled) return
      setTabId(id)
      if (id === null) return
      stop = createTabScope(id, (reason) => {
        setResetCount((n) => n + 1)
        resetScanState()
        // Clearing and re-scanning are different decisions. Re-scanning on every
        // tab ACTIVATION would spend one batched `claude -p` resolve per tab
        // switch; on a tab CLOSE it would scan a tab that no longer exists.
        if (reason === 'navigated') setScanNonce((n) => n + 1)
      })
    }
    if (override !== null) bind(Number(override))
    else void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => bind(tabs[0]?.id ?? null))
    return () => { cancelled = true; if (stop !== null) stop() }
  }, [])

  useEffect(() => { void loadResume().then((r) => setResumeName(r?.name ?? null)) }, [])

  // Pre-fill the facts editor from the host once the self-check answered.
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

  // Snapshot pushes arrive stamped by the SERVICE WORKER with the sender's
  // tabId/frameId (the content script can know neither). Stale epochs are
  // rejected: handles from an old scan must never leak into a save.
  useEffect(() => {
    const onMsg = (raw: unknown): void => {
      const m = raw as { kind?: string; tabId?: number; frameId?: number; snap?: { epoch: number; values: Record<number, string> } }
      if (m?.kind !== 'snapshotPush' || m.snap === undefined || m.tabId !== tabId) return
      if (m.snap.epoch !== epochRef.current) return
      const frameId = m.frameId ?? 0
      const values = m.snap.values
      setSnapshot((s) => {
        const next = { ...s }
        for (const [fid, v] of Object.entries(values)) next[`${frameId}:${fid}`] = v
        return next
      })
    }
    chrome.runtime.onMessage.addListener(onMsg)
    return () => chrome.runtime.onMessage.removeListener(onMsg)
  }, [tabId])

  /* --------------------------------------------------------------- actions */

  const sendToTab = async (frameId: number | undefined, message: ContentMessage): Promise<SendResult> => {
    const res = await chrome.runtime.sendMessage({ kind: 'toContent', tabId, frameId, message }) as
      { ok?: boolean; error?: string; replies?: FrameReply[]; failures?: RelayFailure[] } | undefined
    // A relay that answers ok:false — or does not answer at all — is a failure the
    // user must SEE. The old `?? []` here is how three real failure modes rendered
    // as "nothing happened".
    if (res?.ok !== true) throw new Error(res?.error ?? 'The extension background did not answer.')
    return { replies: res.replies ?? [], failures: res.failures ?? [] }
  }

  /** chrome.tabs.get REJECTS once the bound tab is gone; every caller here runs
   *  from an event the user does not control. */
  const getTab = async (): Promise<chrome.tabs.Tab | null> => {
    if (tabId === null) return null
    try { return await chrome.tabs.get(tabId) } catch { return null }
  }

  const onEdit = (ref: string, value: string): void => setEdits((e) => ({ ...e, [ref]: value }))

  const onScan = async (): Promise<void> => {
    const port = portRef.current
    if (port === null || tabId === null || scanningRef.current) return
    // Busy state and re-entry guard flip TOGETHER, before any await: between them
    // the scan is already committed while the button would still read 'Scan'.
    scanningRef.current = true
    setScanning(true)
    try {
      const tab = await getTab()
      if (tab === null) return // the tab closed between the trigger and here
      // A previous application on this same tab may have left snapshot rows in
      // storage.session; they must never merge into this scan's save.
      const staleKeys = Object.keys(await chrome.storage.session.get(null))
        .filter((k) => { const m = SNAPSHOT_KEY_RE.exec(k); return m !== null && Number(m[1]) === tabId })
      if (staleKeys.length > 0) await chrome.storage.session.remove(staleKeys)

      const hostname = hostnameOf(tab.url)
      // Company: the user's edit always wins; guess only while the field is empty.
      const co = companyOrNull ?? guessCompany(tab.title ?? '', hostname)
      if (co !== null && companyOrNull === null) setCompany(co)
      setFrameReports([])
      const out = await runScan({
        tabId,
        nextEpoch: () => ++epochRef.current,
        inject: async () => {
          const r = await chrome.runtime.sendMessage({ kind: 'inject', tabId }) as
            { ok?: boolean; error?: string; frames?: number[] } | undefined
          if (r?.ok !== true) throw new Error(r?.error ?? 'Could not reach the page.')
          return r.frames ?? []
        },
        sendToTab,
        onProgress: (p: ScanProgress) => setScanStatus(
          p.phase === 'enumerating' ? { kind: 'enumerating', frames: p.frames }
          : p.phase === 'resolving' ? { kind: 'resolving', fields: p.fields }
          : { kind: p.phase },
        ),
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
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
      setFrameReports(out.frameReports)
      setEdits({})
      setGeneratedRefs([])
      setFilledRefs([])
      setSnapshot({})
      if (out.jobText !== '') setJobText(out.jobText)
      if (out.llmError !== null) setHostError(ERROR_COPY[out.llmError.kind])
      // DELIBERATE: these counts mirror the Filled/Proposed/Needs-input group
      // headers exactly (all `auto` resolutions count as "filled", including
      // page-sourced ones). Verifying the SCAN's batched auto-fills against their
      // JFF_FILL reports is a future slice — spec's out-of-scope list. (Accept and
      // Fill, which the user triggers one at a time, DO check theirs: see fillOne.)
      const filled = out.resolutions.filter((r) => r.tier === 'auto').length
      const proposed = out.resolutions.filter((r) => r.tier === 'proposed').length
      const needsInput = out.resolutions.filter((r) => r.tier === 'needs_input').length
      // Precedence: captcha > empty > llm failure > done. A captcha'd page may
      // also be field-less; the captcha is the actionable fact.
      setScanStatus(
        out.activeCaptcha ? { kind: 'captcha' }
        // DISTINCT frames: a frame that errored first-pass and replied on the retry
        // contributes two reports but is still one frame on the page.
        : out.fields.length === 0 ? { kind: 'empty', frames: new Set(out.frameReports.map((r) => r.frameId)).size }
        : out.llmError !== null ? { kind: 'failed', reason: ERROR_COPY[out.llmError.kind] }
        : { kind: 'done', filled, proposed, needsInput },
      )
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      setScanStatus({ kind: 'failed', reason })
      // Synthetic relay report (frameId -1): without it the diagnostics
      // disclosure could NEVER render for inject/broadcast failures, because
      // frameReports was cleared at scan start. ScanStatus renders -1 as "relay".
      // A ScanError died AFTER enumerating, so its evidence is kept and the
      // synthetic row APPENDED to it, never substituted for it.
      const relayRow: FrameReport = { frameId: -1, url: null, fields: null, error: reason }
      setFrameReports(e instanceof ScanError ? [...e.frameReports, relayRow] : [relayRow])
    } finally {
      setScanning(false)
      scanningRef.current = false
    }
  }

  // Auto-scan on open and after the bound tab NAVIGATES (a wizard step is new DOM).
  // Deliberately NOT keyed on resetCount: a tab switch or close clears state
  // without spending another batched `claude -p` resolve.
  // `hostAnswered` latches false->true ONCE (selfCheck answers or fails); keying
  // on `hostError` directly would re-fire the auto-scan every time a later host
  // error (e.g. an llmError) sets it — an accidental scan loop.
  const hostAnswered = check !== null || hostError !== null
  // The wait is BOUNDED: a host that connects but never answers would otherwise
  // pin the panel on 'connecting' forever (before the gate existed the scan just
  // fired). After the deadline the scan runs anyway and its resolve call surfaces
  // the host problem loudly. `gateOpen` latches false->true exactly once, so the
  // late arrival of a selfCheck AFTER the deadline cannot fire a second scan.
  useEffect(() => {
    if (hostAnswered) { setGateOpen(true); return }
    const timer = setTimeout(() => setGateOpen(true), hostWaitMs)
    return () => clearTimeout(timer)
  }, [hostAnswered, hostWaitMs])
  useEffect(() => {
    if (tabId === null) return
    if (!gateOpen) { setScanStatus({ kind: 'connecting' }); return }
    void onScan()
  }, [tabId, scanNonce, gateOpen])

  /** Put one value on the page. Shared by Accept and Fill; what they additionally
   *  CONFIRM is the only difference between them. THROWS if the relay or the
   *  frame refused the fill — callers must not confirm anything on a throw. */
  const fillOne = async (row: Row, value: string): Promise<void> => {
    if (tabId === null || value === '') return
    const { replies } = await sendToTab(row.field.frameId, {
      type: 'JFF_FILL', epoch: row.field.epoch, fills: [{ handle: row.resolution.handle, value }],
    })
    const p = replies[0]?.payload as { ok?: boolean; error?: string; fill?: FillReport } | undefined
    if (p?.ok !== true) throw new Error(p?.error ?? 'the page rejected the fill')
    // An `ok` ENVELOPE is not a filled field: the content script answers ok:true
    // with a per-field `failed` list (no-matching-option, element-not-found,
    // click-rejected, unsupported-widget). Confirming on that is how a row got
    // marked "on the page" while the page never took the value.
    const failed = p.fill?.failed ?? []
    if (failed.length > 0) throw new Error(failed[0]!.reason)
  }

  const onAccept = async (ref: string): Promise<void> => {
    const row = groups.proposed.find((r) => r.ref === ref)
    if (row === undefined || acting !== null) return
    const value = edits[ref] ?? row.resolution.value ?? ''
    if (value === '') return
    setActing({ ref, action: 'accept' })
    try {
      await fillOne(row, value)
      // Accepting an AI key match IS the user confirmation the spec's
      // learned_mappings flow needs: promote it to a deterministic mapping.
      if (row.resolution.source === 'llm_key' && row.resolution.key !== null && row.field.label !== null) {
        void portRef.current?.request('mapping.confirm', { label: row.field.label, fieldKey: row.resolution.key })
      }
      // Promote the TIER only. Writing `value` back onto the resolution would make
      // engine === final in buildSaveItems and silently drop every user correction
      // to a proposed answer. The edit lives in `edits`, where the save diff reads it.
      setResolutions((rs) => rs.map((r) => (refOf(r.handle) === ref ? { ...r, tier: 'auto' as const } : r)))
    } catch (e) {
      setScanStatus({ kind: 'action_failed', reason: `Accept failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setActing(null)
    }
  }

  /** Closes the spec's [Generate] loop: draft, edit, then put it on the page.
   *  Unlike Accept this confirms no mapping and promotes no tier — a needs-input
   *  row has no LLM-proposed key, only an answer the user wrote. */
  const onFill = async (ref: string): Promise<void> => {
    const row = groups.needs_input.find((r) => r.ref === ref)
    if (row === undefined || acting !== null) return
    const value = edits[ref] ?? row.resolution.value ?? ''
    if (value.trim() === '') return
    setActing({ ref, action: 'fill' })
    try {
      await fillOne(row, value)
      setFilledRefs((f) => (f.includes(ref) ? f : [...f, ref]))
    } catch (e) {
      setScanStatus({ kind: 'action_failed', reason: `Fill failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setActing(null)
    }
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
    if (r.ok) {
      setEdits((e) => ({ ...e, [ref]: r.result.draft }))
      setGeneratedRefs((g) => (g.includes(ref) ? g : [...g, ref]))
    } else {
      setHostError(ERROR_COPY[r.error.kind])
    }
  }

  const onPickJobText = async (): Promise<void> => {
    if (tabId === null || fields.length === 0 || picking) return
    setPicking(true)
    try {
      // Always settles: click, Escape (pick_cancelled) or timeout (Task 17 Step 5).
      const { replies } = await sendToTab(0, { type: 'JFF_PICK', epoch: epochRef.current })
      const p = replies[0]?.payload as { ok: boolean; pick?: { selector: string; text: string } } | undefined
      if (p?.ok !== true || p.pick === undefined) return // cancelled; leave the paste box alone
      setJobText(p.pick.text)
      const tab = await getTab()
      const hostname = hostnameOf(tab?.url)
      if (hostname !== '') {
        await portRef.current?.request('selector.save', { hostname, purpose: 'job_description', selector: p.pick.selector })
      }
    } catch (e) {
      // A relay failure mid-pick is NOT a cancel: say so.
      setScanStatus({ kind: 'action_failed', reason: `Pick failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setPicking(false)
    }
  }

  const onPickResume = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (file === undefined) return
    await saveResume(file)
    setResumeName(file.name)
  }

  const onSaveFacts = async (profile: Record<string, string>, bank: Record<string, string>): Promise<void> => {
    const port = portRef.current
    if (port === null) return
    await port.request('profile.set', { values: profile })
    await port.request('answerBank.set', { values: bank })
    // Merge, never replace: the editor omits keys it never loaded (Task 19 Step 9b).
    setFacts((f) => ({ ...f, ...profile, ...bank }))
    setShowEditor(false)
  }

  const onSaveAnswers = async (): Promise<void> => {
    const port = portRef.current
    if (port === null || tabId === null || saving) return
    setSaving(true)
    try {
      // Merge every snapshot source: SW-stamped pushes (state), the storage.session
      // fallback (durable across a beforeunload race), and a fresh on-demand pull
      // (returns {} if the form was already torn down; the pushes covered that).
      const stored = await chrome.storage.session.get(null) as Record<string, StoredSnapshot>
      const live: Record<string, string> = {
        ...snapshot,
        // Tab- and epoch-filtered in save.ts, where the rejection rules are tested.
        ...mergeStoredSnapshots(stored, tabId, epochRef.current),
      }
      for (const r of (await sendToTab(undefined, { type: 'JFF_SNAPSHOT', epoch: epochRef.current })).replies) {
        const p = r.payload as { ok: boolean; snapshot?: { values: Record<string, string> } }
        if (p?.ok !== true || p.snapshot === undefined) continue
        for (const [fid, v] of Object.entries(p.snapshot.values)) live[`${r.frameId}:${fid}`] = v
      }
      const items = buildSaveItems({ fields, resolutions, panelEdits: edits, snapshot: live, company: companyOrNull })
        .map((it) => ({ ...it, reusability: reuseOverrides[refOf(it.handle)] ?? it.reusability }))
      const tab = await getTab()
      const r = await port.request<{ saved: number }>('save', {
        url: tab?.url ?? '',
        company: companyOrNull,
        items,
        generatedCount: generatedRefs.length,
      })
      setSaveMsg(r.ok ? `Saved ${r.result.saved} answer(s).` : ERROR_COPY[r.error.kind])
    } catch (e) {
      setSaveMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  /* ---------------------------------------------------------------- markup */

  const saveItems = buildSaveItems({ fields, resolutions, panelEdits: edits, snapshot, company: companyOrNull })

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
        <button type="button" className={BTN_PRIMARY} disabled={tabId === null || scanning} onClick={onScan}>
          {busyLabel(scanning, 'Scan', 'Scanning…')}
        </button>
        <button type="button" className={BTN} onClick={() => setShowEditor((s) => !s)}>
          {showEditor ? 'Back to fields' : 'Edit your facts'}
        </button>
      </div>

      <ScanStatus status={scanStatus} reports={frameReports} />

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
        <button type="button" className={`${BTN} mt-1`} disabled={fields.length === 0 || picking} onClick={onPickJobText}>
          {busyLabel(picking, 'Pick job description', 'Picking… (click the description on the page)')}
        </button>
      </label>

      {showEditor
        ? (
            // `key` remounts the editor the instant the facts arrive, so an editor
            // opened during the load is never stuck on an empty snapshot.
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
                      acting={acting !== null && acting.ref === row.ref ? acting.action : null}
                      locked={acting !== null}
                    />
                  ))}
                </ul>
              </section>
            )
          ))}

      {saveItems.length > 0 && (
        <details className="mt-3" data-jff-savepreview="1">
          <summary className={`cursor-pointer ${MUTED}`}>Answers to save ({saveItems.length})</summary>
          <ul className="m-0 mt-2 grid list-none gap-2 p-0">
            {saveItems.map((it) => (
              <li className={`${ROW_BASE} border-l-neutral-300 dark:border-l-neutral-600`} key={refOf(it.handle)}>
                <div className="flex items-baseline gap-1.5"><span className="font-semibold">{it.questionRaw}</span></div>
                <label className={`mt-1 block text-[12px] ${MUTED}`}>
                  <input
                    type="checkbox"
                    checked={(reuseOverrides[refOf(it.handle)] ?? it.reusability) === 'company_specific'}
                    onChange={(e) => setReuseOverrides((o) => ({ ...o, [refOf(it.handle)]: e.target.checked ? 'company_specific' : 'reusable' }))}
                  />
                  {' '}Specific to this company (never reused verbatim)
                </label>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="my-2.5 flex items-center gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={saving} onClick={onSaveAnswers}>
          {busyLabel(saving, 'Save answers', 'Saving…')}
        </button>
        {saveMsg !== null && <span className={MUTED} data-jff-savemsg="1">{saveMsg}</span>}
      </div>
    </main>
  )
}
