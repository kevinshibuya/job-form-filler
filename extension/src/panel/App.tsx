import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { ContentMessage, EnumField, FillReport, Resolution, SelfCheck } from '@jff/shared'
import { BANNER_BASE, BANNER_BAD, SelfCheckBanner } from './Banner'
import { guessCompany } from './company'
import { FieldRow } from './FieldRow'
import { buildRows, refOf, type Row } from './group'
import { createHostPort, ERROR_COPY, type HostPort } from './port'
import { ProfileEditor } from './ProfileEditor'
import { loadResume, saveResume } from './resume'
import { pickResumeTarget } from './resumeTarget'
import { runScan, ScanError, type ElectionOutcome, type FrameReply, type FrameReport, type RelayFailure, type ScanProgress, type SendResult } from './scan'
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

/** "host:port (score N)" — the port matters: two fixture origins share a host. */
export const electedFrameName = (e: ElectionOutcome | null): string => {
  if (e === null) return '(none)'
  let host = `frame ${e.frameId}`
  if (e.url !== null) { try { host = new URL(e.url).host } catch { /* keep frame id */ } }
  return `${host} (score ${e.score})`
}

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
  // Bumped by every tab-scope reset. A resolve can take minutes, so a scan very
  // often outlives the page it was started for; its results belong to a dead
  // generation and must never be written back over the reset.
  const resetGenRef = useRef(0)
  // A trigger the guard above swallowed. Only a NAVIGATION re-runs the auto-scan
  // effect, so this can only be set by a page the panel has never scanned.
  const pendingRescanRef = useRef(false)
  // The last SETTLED scan outcome. An action_failed line is transient: when the
  // retried action succeeds the panel goes back to what the scan said.
  const lastOutcomeRef = useRef<ScanUiState | null>(null)
  // Provenance of `company`. A GUESS describes the page that is gone, so a reset
  // drops it; a value the user typed is theirs and survives every reset.
  const companyGuessedRef = useRef(false)
  const [check, setCheck] = useState<SelfCheck | null>(null)
  const [hostError, setHostError] = useState<string | null>(null)
  const [tabId, setTabId] = useState<number | null>(null)
  const [resetCount, setResetCount] = useState(0)
  const [scanNonce, setScanNonce] = useState(0)
  const [fields, setFields] = useState<EnumField[]>([])
  const [resolutions, setResolutions] = useState<Resolution[]>([])
  const [election, setElection] = useState<ElectionOutcome | null>(null)
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

  const { main, foreign } = buildRows(fields, resolutions, election?.frameId ?? null)
  // A8/A9: the SAME pure scorer scan.ts used decides which file row is wired to
  // the stored resume — recomputed over the CURRENT fields so a post-resume
  // re-enumeration can never leave the button on a stale fid.
  const resumeTargetField = pickResumeTarget(main.map((r) => r.field))
  const resumeTargetRef = resumeTargetField === null ? null : refOf(resumeTargetField)
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
  const resetScanState = (reason: 'activated' | 'navigated' | 'removed'): void => {
    // Invalidate whatever scan is in flight BEFORE clearing: its results describe
    // the page that just went away.
    resetGenRef.current++
    // Defensive only — unreachable as a restore source by construction: this same
    // reset clears the rows, and any later action requires a settled scan, which
    // reassigns the ref inside its own generation-guarded block. Kept because the
    // invariant ("a rollback target never outlives its page") must not depend on
    // that reasoning staying true.
    lastOutcomeRef.current = null
    setFields([]); setResolutions([]); setElection(null); setEdits({}); setFilledRefs([]); setGeneratedRefs([])
    setSnapshot({}); setUnreachable(0); setActiveCaptcha(false); setJobText(''); setSaveMsg(null)
    setReuseOverrides({})
    // A guessed company belongs to the employer whose page just went away; keeping
    // it files the NEXT employer's answers under the previous company's name.
    if (companyGuessedRef.current) { companyGuessedRef.current = false; setCompany('') }
    // A scan still draining cannot be cancelled (host-protocol change, deferred to
    // a future slice), and its own writes are dropped — so a blank line here is
    // minutes of a frozen-looking panel. Say what is being waited on instead.
    setScanStatus(scanningRef.current && reason === 'navigated' ? { kind: 'superseded' } : null)
    setFrameReports([])
  }

  /** A SETTLED scan outcome (done/empty/captcha/failed) — remembered so a later
   *  action_failed line can be rolled back to it. */
  const setOutcome = (s: ScanUiState): void => { lastOutcomeRef.current = s; setScanStatus(s) }

  /** An Accept/Fill/Pick that succeeded retires the red line its failed attempt
   *  left behind; anything the scan itself put there stays. */
  const clearActionFailure = (): void => {
    setScanStatus((s) => (s !== null && s.kind === 'action_failed' ? lastOutcomeRef.current : s))
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
        resetScanState(reason)
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
    if (port === null || tabId === null) return
    if (scanningRef.current) {
      // Dropping this trigger silently is how a mid-scan navigation left the new
      // page unscanned forever. Remember it; the running scan replays it.
      pendingRescanRef.current = true
      return
    }
    // Busy state and re-entry guard flip TOGETHER, before any await: between them
    // the scan is already committed while the button would still read 'Scan'.
    scanningRef.current = true
    setScanning(true)
    // Every write below is conditional on this still being the current generation.
    const gen = resetGenRef.current
    try {
      const tab = await getTab()
      // The tab closed between the trigger and here — this replay is a dead end.
      // A lingering 'superseded' from the reset that queued this replay would
      // otherwise promise a rescan that is never coming.
      if (tab === null) { setScanStatus((s) => (s !== null && s.kind === 'superseded' ? null : s)); return }
      // A previous application on this same tab may have left snapshot rows in
      // storage.session; they must never merge into this scan's save.
      const staleKeys = Object.keys(await chrome.storage.session.get(null))
        .filter((k) => { const m = SNAPSHOT_KEY_RE.exec(k); return m !== null && Number(m[1]) === tabId })
      if (staleKeys.length > 0) await chrome.storage.session.remove(staleKeys)

      const hostname = hostnameOf(tab.url)
      // Company: the user's edit always wins; guess only while the field is empty.
      const co = companyOrNull ?? guessCompany(tab.title ?? '', hostname)
      // Post-await write: a dead page's guess must not name the live page's employer.
      if (co !== null && companyOrNull === null && resetGenRef.current === gen) {
        companyGuessedRef.current = true
        setCompany(co)
      }
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
        onProgress: (p: ScanProgress) => {
          if (resetGenRef.current !== gen) return
          setScanStatus(
            p.phase === 'enumerating' ? { kind: 'enumerating', frames: p.frames }
            : p.phase === 'resolving' ? { kind: 'resolving', fields: p.fields }
            : { kind: p.phase },
          )
        },
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
        port,
        getResume: loadResume,
        pastedJobText: jobText,
        hostname,
        url: tab.url ?? '',
        company: co,
      })
      // The bound tab navigated (or closed) while this scan ran: these fields,
      // resolutions and counts describe a page that is no longer on screen, and
      // every JFF_FILL they claim was answered stale_epoch. Drop the whole write.
      if (resetGenRef.current !== gen) return
      setFields(out.fields)
      // B3: a resolution whose batched auto-fill the page REJECTED is not
      // "filled" — demote it to needs_input carrying the fill reason, so the
      // row drops to needs-input styling, REASON_HINT renders the hint
      // (choice-needs-user-click → "Select this answer on the page yourself."),
      // and the user gets Generate/Fill to recover. Page-sourced rows are never
      // in `failed` (the loop skips them), so `already on page` is untouched.
      const failedFillReason = new Map(out.fill.failed.map((f) => [refOf(f.handle), f.reason]))
      const resolutions = out.resolutions.map((r) =>
        failedFillReason.has(refOf(r.handle))
          ? { ...r, tier: 'needs_input' as const, reason: failedFillReason.get(refOf(r.handle))! }
          : r)
      setResolutions(resolutions)
      setElection(out.election)
      setUnreachable(out.unreachableWidgets)
      setActiveCaptcha(out.activeCaptcha)
      setFrameReports(out.frameReports)
      // B1c: batch fills that committed canonical text different from the sent
      // value seed `edits`, so the row, the save diff and the choice highlight
      // all speak the page's language ('bra' → 'Brazil').
      const committedEdits: Record<string, string> = {}
      for (const f of out.fill.filled) {
        if (f.committed !== null) committedEdits[refOf(f.handle)] = f.committed
      }
      setEdits(committedEdits)
      setGeneratedRefs([])
      setFilledRefs([])
      setSnapshot({})
      if (out.jobText !== '') setJobText(out.jobText)
      if (out.llmError !== null) setHostError(ERROR_COPY[out.llmError.kind])
      // A9/B3 status semantics: `filled` = PAGE-ACCEPTED batched fills, straight
      // from the frames' JFF_FILL reports — never inferred from tiers, so a
      // failed batch can never inflate it. `already on page` = page-sourced
      // values the engine never wrote. The remaining counts run over the
      // DEMOTED array so the four numbers always describe the rows on screen.
      const filled = out.fill.filled.length
      const alreadyOnPage = resolutions.filter((r) => r.tier === 'auto' && r.source === 'page').length
      const proposed = resolutions.filter((r) => r.tier === 'proposed').length
      const needsInput = resolutions.filter((r) => r.tier === 'needs_input').length
      // Precedence: captcha > empty > llm failure > done. A captcha'd page may
      // also be field-less; the captcha is the actionable fact.
      setOutcome(
        out.activeCaptcha ? { kind: 'captcha' }
        // DISTINCT frames: a frame that errored first-pass and replied on the retry
        // contributes two reports but is still one frame on the page.
        : out.fields.length === 0 ? { kind: 'empty', frames: new Set(out.frameReports.map((r) => r.frameId)).size }
        : out.llmError !== null ? { kind: 'failed', reason: ERROR_COPY[out.llmError.kind] }
        : { kind: 'done', filled, alreadyOnPage, proposed, needsInput },
      )
    } catch (e) {
      // Same rule as the success path: a dead generation's failure is not this
      // page's failure.
      if (resetGenRef.current !== gen) return
      const reason = e instanceof Error ? e.message : String(e)
      setOutcome({ kind: 'failed', reason })
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
      // Replay a trigger the guard swallowed. Bumping the nonce (rather than
      // calling onScan here) re-runs the auto-scan effect, so the replay reads
      // the CURRENT render's state instead of this run's dead-page closure.
      // Only `navigated` bumps the nonce in the first place, so a tab switch or a
      // tab close still clears without spending another batched `claude -p`.
      if (pendingRescanRef.current) {
        pendingRescanRef.current = false
        setScanNonce((n) => n + 1)
      }
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
   *  frame refused the fill — callers must not confirm anything on a throw.
   *  Returns the page-accepted canonical text when it differs from what was
   *  sent (B1c: 'bra' commits 'Brazil'), else null. */
  const fillOne = async (row: Row, value: string): Promise<string | null> => {
    if (tabId === null || value === '') return null
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
    // Codex-review hardening: an ok envelope whose report mentions this fill
    // in NEITHER list is not a success — confirming on it is the "marked on
    // the page while the page never took the value" bug in a new coat.
    const mine = p.fill?.filled.find((f) =>
      f.handle.frameId === row.resolution.handle.frameId && f.handle.fid === row.resolution.handle.fid) ?? null
    if (mine === null) throw new Error('fill unreported')
    return mine.committed
  }

  const onAccept = async (ref: string): Promise<void> => {
    const row = main.find((r) => r.ref === ref && r.resolution.tier === 'proposed')      // onAccept
    if (row === undefined || acting !== null) return
    const value = edits[ref] ?? row.resolution.value ?? ''
    if (value === '') return
    // Same rule as the scan: this row, this value and this failure all describe the
    // page the click was made on. A JFF_FILL answering after a navigation is about
    // a dead page — its verdict must reach neither the status line nor the rows.
    const gen = resetGenRef.current
    setActing({ ref, action: 'accept' })
    try {
      const committed = await fillOne(row, value)
      if (resetGenRef.current !== gen) return
      if (committed !== null) setEdits((e) => ({ ...e, [ref]: committed }))
      // Accepting an AI key match IS the user confirmation the spec's
      // learned_mappings flow needs: promote it to a deterministic mapping.
      if (row.resolution.source === 'llm_key' && row.resolution.key !== null && row.field.label !== null) {
        void portRef.current?.request('mapping.confirm', { label: row.field.label, fieldKey: row.resolution.key })
      }
      // Promote the TIER only. Writing `value` back onto the resolution would make
      // engine === final in buildSaveItems and silently drop every user correction
      // to a proposed answer. The edit lives in `edits`, where the save diff reads it.
      setResolutions((rs) => rs.map((r) => (refOf(r.handle) === ref ? { ...r, tier: 'auto' as const } : r)))
      clearActionFailure()
    } catch (e) {
      if (resetGenRef.current !== gen) return
      setScanStatus({ kind: 'action_failed', reason: `Accept failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setActing(null)
    }
  }

  /** Closes the spec's [Generate] loop: draft, edit, then put it on the page.
   *  Unlike Accept this confirms no mapping and promotes no tier — a needs-input
   *  row has no LLM-proposed key, only an answer the user wrote. */
  const onFill = async (ref: string): Promise<void> => {
    const row = [...main, ...foreign].find((r) => r.ref === ref && r.resolution.tier === 'needs_input') // onFill
    if (row === undefined || acting !== null) return
    const value = edits[ref] ?? row.resolution.value ?? ''
    if (value.trim() === '') return
    // A ref is `frameId:fid` — it carries no epoch, so the NEW page's field 0:1
    // would wear a dead page's "on the page" badge without this.
    const gen = resetGenRef.current
    setActing({ ref, action: 'fill' })
    try {
      const committed = await fillOne(row, value)
      if (resetGenRef.current !== gen) return
      if (committed !== null) setEdits((e) => ({ ...e, [ref]: committed }))
      setFilledRefs((f) => (f.includes(ref) ? f : [...f, ref]))
      clearActionFailure()
    } catch (e) {
      if (resetGenRef.current !== gen) return
      setScanStatus({ kind: 'action_failed', reason: `Fill failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setActing(null)
    }
  }

  /** A9: put the stored resume on the A8-winning file row, targeting ITS fid
   *  through the existing base64 JFF_FILL_RESUME plumbing. */
  const onFillResume = async (ref: string): Promise<void> => {
    const row = main.find((r) => r.ref === ref)
    if (row === undefined || tabId === null || acting !== null) return
    const resume = await loadResume()
    if (resume === null) return
    const gen = resetGenRef.current
    setActing({ ref, action: 'fill' })
    try {
      const { replies } = await sendToTab(row.field.frameId, {
        type: 'JFF_FILL_RESUME', epoch: row.field.epoch,
        handle: { frameId: row.field.frameId, fid: row.field.fid, epoch: row.field.epoch },
        fileName: resume.name, mimeType: resume.mimeType, dataBase64: resume.dataBase64,
      })
      if (resetGenRef.current !== gen) return
      const p = replies[0]?.payload as { ok?: boolean; error?: string } | undefined
      if (p?.ok !== true) throw new Error(p?.error ?? 'the page rejected the file')
      setFilledRefs((f) => (f.includes(ref) ? f : [...f, ref]))
      clearActionFailure()
    } catch (e) {
      if (resetGenRef.current !== gen) return
      setScanStatus({ kind: 'action_failed', reason: `Resume fill failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setActing(null)
    }
  }

  const onGenerate = async (ref: string): Promise<void> => {
    const row = main.find((r) => r.ref === ref && r.resolution.tier === 'needs_input')   // onGenerate (foreign rows never generate)
    const port = portRef.current
    if (row === undefined || port === null) return
    setGeneratingRef(ref)
    const r = await port.request<{ draft: string }>('generate', {
      handle: row.resolution.handle,
      questionRaw: row.field.label ?? '',
      description: row.field.description,
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
    // The picked text — and the selector learned from it — describe the page the
    // pick started on; everything below this await is dropped once that page is gone.
    const gen = resetGenRef.current
    setPicking(true)
    try {
      // Always settles: click, Escape (pick_cancelled) or timeout (Task 17 Step 5).
      const { replies } = await sendToTab(0, { type: 'JFF_PICK', epoch: epochRef.current })
      if (resetGenRef.current !== gen) return
      const p = replies[0]?.payload as { ok: boolean; pick?: { selector: string; text: string } } | undefined
      if (p?.ok !== true || p.pick === undefined) return // cancelled; leave the paste box alone
      setJobText(p.pick.text)
      clearActionFailure()
      const tab = await getTab()
      if (resetGenRef.current !== gen) return
      const hostname = hostnameOf(tab?.url)
      if (hostname !== '') {
        await portRef.current?.request('selector.save', { hostname, purpose: 'job_description', selector: p.pick.selector })
      }
    } catch (e) {
      if (resetGenRef.current !== gen) return
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
        {resumeName !== null && main.some((r) => r.field.kind === 'file') && resumeTargetRef === null && (
          <span className="text-amber-600 dark:text-amber-400" data-jff-resume-note="1"> — resume field not identified; nothing was uploaded</span>
        )}
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
          // Typing makes the value the USER's: a later tab-scope reset keeps it.
          onChange={(e) => { companyGuessedRef.current = false; setCompany(e.target.value) }}
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
        : (
            <>
              {main.length > 0 && (
                <section className="mt-4" data-jff-rows="1">
                  <ul className="m-0 grid list-none gap-2 p-0">
                    {main.map((row) => (
                      <FieldRow
                        key={row.ref} row={row} edited={edits[row.ref] ?? null}
                        onEdit={onEdit} onAccept={onAccept} onGenerate={onGenerate} onFill={onFill}
                        generating={generatingRef === row.ref}
                        filled={filledRefs.includes(row.ref)}
                        acting={acting !== null && acting.ref === row.ref ? acting.action : null}
                        locked={acting !== null}
                        resumeTarget={row.ref === resumeTargetRef}
                        resumeName={resumeName}
                        onFillResume={onFillResume}
                      />
                    ))}
                  </ul>
                </section>
              )}
              {foreign.length > 0 && (
                // Collapsed at the bottom, NAMING the elected frame so a
                // mis-election is visible and explainable (the override UI is
                // spec-deferred; this header is the mitigation).
                <details className="mt-4" data-jff-foreign="1">
                  <summary className={`cursor-pointer text-[11px] font-semibold uppercase tracking-widest ${MUTED}`}>
                    Other page fields ({foreign.length}) — application frame: {electedFrameName(election)}
                  </summary>
                  <ul className="m-0 mt-2 grid list-none gap-2 p-0">
                    {foreign.map((row) => (
                      <FieldRow
                        key={row.ref} row={row} edited={edits[row.ref] ?? null}
                        onEdit={onEdit} onAccept={onAccept} onGenerate={onGenerate} onFill={onFill}
                        generating={false}
                        filled={filledRefs.includes(row.ref)}
                        acting={acting !== null && acting.ref === row.ref ? acting.action : null}
                        locked={acting !== null}
                        foreign
                      />
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

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
