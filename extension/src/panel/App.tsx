import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { ContentMessage, EnumField, FillReport, HostErrorKind, Resolution, SelfCheck } from '@jff/shared'
import { BANNER_BASE, BANNER_BAD, SelfCheckBanner } from './Banner'
import { guessCompany } from './company'
import { FieldRow } from './FieldRow'
import { buildRows, refOf, type Row } from './group'
import { createHostPort, ERROR_COPY, hostErrorText, type HostPort } from './port'
import { profileCompleteness, type Completeness } from './completeness'
import { OnboardingView } from './OnboardingView'
import { ProfileEditor } from './ProfileEditor'
import { ApplicationsView, type AppliedJobRow } from './ApplicationsView'
import { loadResume, loadResumeText, saveResume } from './resume'
import { pickResumeTarget } from './resumeTarget'
import { runScan, ScanError, type ElectionOutcome, type FrameReply, type FrameReport, type RelayFailure, type ScanProgress, type SendResult } from './scan'
import { ScanStatus, type ScanUiState } from './ScanStatus'
import { buildSaveItems, mergeStoredSnapshots, type StoredSnapshot } from './save'
import { createNavSignals, NAV_FALLBACK_DEDUPE_MS, type NavEvent } from './navSignals'
import { createSessionStore, newSession, projectAnswers, rememberAnswer, SESSION_SAVE_DEBOUNCE_MS, type Session, type SessionStore } from './sessions'
import { registrableDomain, sameSite } from './site'
import { detectSubmission } from './submission'
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

/**
 * S2: the per-session state that is NEVER persisted, because it describes work
 * in FLIGHT rather than the application. Keyed by tabId so a tab switch cannot
 * leak one session's guards into another's — a panel-global `appliedOverride`
 * would let Scan-anyway on tab 7 suppress tab 8's badge, and a panel-global
 * prompt-dismissal would silence a different page's submit prompt.
 */
interface SessionRuntime {
  /** The session's generation. Bumped by everything that makes its in-flight
   *  work describe a page that is gone: navigation, parking, deletion. Every
   *  post-await write is conditional on it (the old resetGenRef, per session).
   *  A tab SWITCH is deliberately not one of them: the outgoing session's
   *  in-flight work is still valid, it just settles into storage instead.
   *
   *  Values come from ONE panel-wide monotonic source (`nextGen`), not a
   *  per-tab count. Only equality is ever asked of them, and global uniqueness
   *  is what makes a runtime entry SAFE TO DELETE when its tab closes: a
   *  runtime rebuilt for that tab id later starts beyond every generation ever
   *  issued, so an in-flight settle still carrying the old one is refused. A
   *  per-tab counter restarting at 0 would ACCEPT it. */
  gen: number
  /** S7: the session's epoch counter, mirrored here so `runScan`'s synchronous
   *  `nextEpoch` hand-off does not have to await the session write. Seeded from
   *  (and never behind) the session's persisted `epoch`. */
  epoch: number
  /** A scan trigger the GLOBAL single-flight latch swallowed; the running scan
   *  replays it. Doubles as the queued re-scan's validity bit: parking or ending
   *  the session clears it, and the FIFO drain skips what it no longer finds set. */
  pendingRescan: boolean
  /** A4: "Scan anyway" belongs to ONE session. */
  appliedOverride: boolean
  /** B4: the running batch's progress, kept PER SESSION because `display`
   *  blanks the in-flight React state on every swap — including a swap back to
   *  the same session, which left the button reading "Generate all remaining"
   *  while the batch was mid-await. */
  generateAll: { done: number; total: number } | null
  /** B4: set when a batch stopped because its session left the screen. The
   *  batch is bound to the DISPLAYED session (generateOne reads `main` and
   *  `scopeNow`), so a tab switch ends it — that must be SAID, not silently
   *  reverted to a button that looks like nothing ever ran. */
  generatePaused: { done: number; total: number } | null
  /** A3: the generation a submit prompt was dismissed against — only a NEW
   *  navigation may re-arm it. */
  promptDismissedGen: number
  /** A3: what the page that just navigated away had; the re-scan's detection
   *  compares against it. */
  navRescan: { prevFields: number } | null
}

const newRuntime = (gen: number): SessionRuntime => ({
  gen, epoch: 0, pendingRescan: false, appliedOverride: false, promptDismissedGen: -1, navRescan: null,
  generateAll: null, generatePaused: null,
})

/**
 * S7: the one-shot enumeration retry sleeps RETRY_DELAY_MS with nothing able to
 * cancel it. The `sleep` the panel injects rejects with this instead of resolving
 * once the scan's session has navigated/died or the panel unmounted, so a dead
 * scan can no longer fire a real inject + JFF_SCAN at a page it stopped
 * describing. Recognised (and swallowed) by onScan's own catch.
 */
const SCAN_ABORTED = 'jff:scan-aborted'

/**
 * The routed writers below are fired-and-forgotten by design (a snapshot push, a
 * background navigation, the epoch bump) and now reach `chrome.storage.session`,
 * which REJECTS on an invalidated extension context. A floating rejection is a
 * console error the panel cannot act on and the browser smoke would flag — the
 * store's own quota/eviction policy is what reports the failures that matter.
 */
const swallow = (): undefined => undefined

/** Everything a scan produced. A navigation makes ALL of it describe a page that
 *  is gone, and the ref-keyed halves are meaningless across a re-enumeration
 *  (`fid` restarts at 0). What RIDES the session — company, jobText, answers,
 *  startUrl, site — is deliberately kept (S4/S5). */
const clearScanResults = (s: Session): Session => ({
  ...s,
  fields: [], resolutions: [], election: null, edits: {}, filledRefs: [], generatedRefs: [],
  snapshot: {}, reuseOverrides: {}, unreachable: 0, activeCaptcha: false, frameReports: [],
  lastOutcome: null, appliedHit: null,
})

export interface AppProps {
  /** Injected only by tests, so the gate's timeout is provable without fake timers. */
  hostWaitMs?: number
}

export function App({ hostWaitMs = HOST_WAIT_MS }: AppProps = {}) {
  const portRef = useRef<HostPort | null>(null)

  /* ------------------------------------------------- the displayed session */

  const [session, setSession] = useState<Session | null>(null)
  // Mirror of what was LAST handed to setSession. The swap handler must save
  // exactly that object (S6): a `useEffect` keyed on `session` lags a render,
  // and the outgoing session would be persisted one edit behind.
  const sessionRef = useRef<Session | null>(null)
  const [tabId, setTabId] = useState<number | null>(null)
  const tabIdRef = useRef<number | null>(null)
  // ?tabId= pins the panel to one tab (e2e/test harness); `activated` is then
  // not ours to follow.
  const overrideModeRef = useRef(false)
  // Monotonic swap counter plus the tab the in-flight swap is heading TO (`null`
  // when none is). `seq` is what makes only the LATEST swap's async work commit
  // to the display; `target` is what lets an `onRemoved` invalidate ONLY the work
  // that would put the REMOVED tab on screen. Held as one object so a bump can
  // never leave a stale target behind.
  const swapRef = useRef<{ seq: number; target: number | null }>({ seq: 0, target: null })

  /** Invalidate every swap currently in flight; returns the new sequence number,
   *  which the caller's own swap (if any) then owns. */
  const bumpSwap = (target: number | null = null): number => {
    const seq = swapRef.current.seq + 1
    swapRef.current = { seq, target }
    return seq
  }
  const runtimesRef = useRef(new Map<number, SessionRuntime>())
  // The GLOBAL single-flight latch: tab switching must never multiply the paid
  // `claude -p` resolves.
  const scanningRef = useRef(false)
  // S7: re-scans the latch could not run yet, oldest first. Membership is the
  // ORDER; `pendingRescan` on the runtime is the validity bit.
  const rescanQueueRef = useRef<number[]>([])
  // A dead panel must not keep scanning: the injected `sleep` reads this.
  const mountedRef = useRef(true)
  // (tabId → the navigation last ACTED on). navSignals' fallback dedupe is
  // one-directional: Chrome can emit a combined tabs.onUpdated
  // {status:'loading', url} AHEAD of onCommitted, i.e. TWO identical
  // `navigated` events for one navigation. Acting twice would double-park,
  // double-unpark, or pay for two resolves. Deduped HERE rather than in
  // navSignals, where a deferral timer would have no unmount/abort linkage.
  const lastNavRef = useRef(new Map<number, { url: string; at: number }>())
  // The last SETTLED scan outcome. An action_failed line is transient: when the
  // retried action succeeds the panel goes back to what the scan said.
  const lastOutcomeRef = useRef<ScanUiState | null>(null)
  // O3: the scan gate as `onScan` must read it. It has to be a REF: the nav
  // signal listeners are registered once at mount, so `onNavigatedBackground`'s
  // `onScan` closure would forever see the mount-time (closed, 'pending') gate
  // and silently refuse every background re-scan for the life of the panel.
  const scanGateRef = useRef(false)

  /* -------------------------------------------------- panel-global UI state */

  const [check, setCheck] = useState<SelfCheck | null>(null)
  const [hostError, setHostError] = useState<string | null>(null)
  const [booted, setBooted] = useState(false)
  const [scanNonce, setScanNonce] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [view, setView] = useState<'session' | 'editor' | 'applications'>('session')
  const [facts, setFacts] = useState<Record<string, string>>({})
  const [factsLoaded, setFactsLoaded] = useState(false)
  const [resumeName, setResumeName] = useState<string | null>(null)
  // B2b: extracted CV text, loaded once (lazily re-extracted for a pre-B2a
  // stored resume) and sent as trusted context with every generate.
  const [cvText, setCvText] = useState<string | null>(null)
  const [gateOpen, setGateOpen] = useState(false)
  const [factsOk, setFactsOk] = useState<boolean | null>(null)     // null = load pending
  const [resumeOk, setResumeOk] = useState<boolean | null>(null)
  const [completeness, setCompleteness] = useState<'pending' | Completeness>('pending')
  // S6: its OWN banner. It must NOT flow through `hostError` — that state feeds
  // SelfCheckBanner AND the hostAnswered→gateOpen latch, and a storage warning
  // is not a host answer.
  const [storageWarning, setStorageWarning] = useState(false)
  // B8: Mark applied DELETES the session, so nothing session-borne can render
  // afterwards. The confirmation is panel-global and TRANSIENT.
  const [markedMsg, setMarkedMsg] = useState<{ markedAt: string } | null>(null)

  /* ----------------------------------- per-session in-flight (display-bound) */

  const [scanStatus, setScanStatus] = useState<ScanUiState | null>(null)
  // B3: one entry per in-flight generate — concurrent row generates are
  // independent host requests, and completing one must not touch the others.
  const [generatingRefs, setGeneratingRefs] = useState<ReadonlySet<string>>(new Set())
  const [generateAll, setGenerateAll] = useState<{ done: number; total: number } | null>(null)
  const [generatePaused, setGeneratePaused] = useState<{ done: number; total: number } | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [marking, setMarking] = useState(false)
  const [acting, setActing] = useState<{ ref: string; action: 'accept' | 'fill' } | null>(null)
  const [submitPrompt, setSubmitPrompt] = useState(false)

  /* ------------------------------------------------------------ the store */

  const storeRef = useRef<SessionStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = createSessionStore(chrome.storage.session, SESSION_SAVE_DEBOUNCE_MS, {
      onWarn: () => setStorageWarning(true),
      // S14 eviction protection: the row on screen is never the victim.
      getDisplayedTabId: () => sessionRef.current?.tabId ?? null,
    })
  }
  const store = storeRef.current

  /** Panel-wide, strictly increasing. Starts at 1 so it never collides with
   *  `promptDismissedGen`'s -1 sentinel. */
  const genSeqRef = useRef(0)
  const nextGen = (): number => ++genSeqRef.current

  const runtimeOf = (id: number): SessionRuntime => {
    const found = runtimesRef.current.get(id)
    if (found !== undefined) return found
    const made = newRuntime(nextGen())
    runtimesRef.current.set(id, made)
    return made
  }

  /** F11: the NON-creating generation read, for the post-await checks. A tab
   *  whose runtime was pruned (its tab closed) must not be resurrected in the
   *  map by a late settle merely asking whether it is still current — and the
   *  honest answer to that question is no, which `null` gives. */
  const genOf = (id: number): number | null => runtimesRef.current.get(id)?.gen ?? null

  /** S7: the runtime's epoch counter never goes backwards, and never behind the
   *  session it belongs to — a fresh reply stamped by a previous scan must not
   *  be able to collide with this one's. */
  const seedEpoch = (s: Session): void => {
    const rt = runtimeOf(s.tabId)
    if (s.epoch > rt.epoch) rt.epoch = s.epoch
  }

  /** A session ENDED (closed / marked / discarded). The runtime entry is kept
   *  but its generation bumped: a settle still in flight for the dead session
   *  must not land in whatever takes its place on the same tab. */
  const endRuntime = (id: number): void => {
    const rt = runtimeOf(id)
    rt.gen = nextGen()
    rt.pendingRescan = false
    rescanQueueRef.current = rescanQueueRef.current.filter((t) => t !== id)
    rt.appliedOverride = false
    rt.promptDismissedGen = -1
    rt.navRescan = null
  }

  /** Show a session without persisting it — the rehydrate/swap paths, where the
   *  row came straight out of storage. */
  const showSession = (s: Session | null): void => { sessionRef.current = s; setSession(s) }

  /** S6 durability: every displayed-session MUTATION goes through the store's
   *  debounced save. A save for a removed (tombstoned) tab is dropped by the
   *  store, which is what keeps a late settle from resurrecting a dead row. */
  const writeSession = (fn: (s: Session) => Session): void => {
    const cur = sessionRef.current
    if (cur === null) return
    const next = fn(cur)
    sessionRef.current = next
    setSession(next)
    store.save(next)
  }

  const startSession = (s: Session): void => { sessionRef.current = s; setSession(s); store.save(s) }

  /** The (tab, generation) an async operation belongs to. */
  const scopeNow = (): { target: number; gen: number } | null => {
    const s = sessionRef.current
    if (s === null) return null
    return { target: s.tabId, gen: runtimeOf(s.tabId).gen }
  }

  /**
   * S7 mid-flight invalidation: does this work still describe a LIVE page? Only
   * the OWNING session's own navigation, parking or death answers no — a tab
   * switch does not, because the outgoing session's work is still perfectly
   * valid, it just has to settle into storage instead of onto the screen.
   */
  const alive = (sc: { target: number; gen: number }): boolean => genOf(sc.target) === sc.gen

  /** …and it is the session ON SCREEN, so DISPLAY-only state (the status line,
   *  the submit prompt, the per-row busy flags) may be touched too. Session
   *  state never goes through this — it goes through `applyToSession`. */
  const inScope = (sc: { target: number; gen: number }): boolean => {
    const s = sessionRef.current
    return s !== null && s.tabId === sc.target && alive(sc)
  }

  /** tabId → how many background writes for it are in flight. `store.onWrite`
   *  repairs the display ONLY from these: an ordinary save-flush notification
   *  carries the CAPPED row the display itself produced, and adopting that would
   *  truncate the option lists an open combobox still needs — and could lose an
   *  edit made between the write and the notification. */
  const bgWriteRef = useRef(new Map<number, number>())

  const mutateSession = async (tabId: number, fn: (s: Session | null) => Session | null): Promise<Session | null> => {
    const marks = bgWriteRef.current
    marks.set(tabId, (marks.get(tabId) ?? 0) + 1)
    try {
      return await store.mutate(tabId, fn)
    } finally {
      const left = (marks.get(tabId) ?? 1) - 1
      if (left <= 0) marks.delete(tabId)
      else marks.set(tabId, left)
    }
  }

  /**
   * S7, THE choke point. Every write that lands AFTER an await goes through here
   * — an ENUMERATION of writers is exactly what kept missing writers (the
   * company guess, `frameReports`, `lastOutcome` were all found late) — and it
   * routes by tabId instead of assuming the display:
   *
   *  - the target is ON SCREEN and its generation still matches → an ordinary
   *    display write: ref-mirrored (so the next reader sees it synchronously)
   *    and save-through;
   *  - anything else → `store.mutate`, NEVER load+save. The store's one global
   *    FIFO lock plus its pending-first read are what make this read-your-writes
   *    over the debounce. A display that swapped between the route decision and
   *    here still lands its write, in the session it belongs to.
   *
   * The mutate fn re-checks the generation against the row it is handed and
   * returns null — the drop arm — when the session died, moved on, or was
   * already removed (`mutate` refuses a tombstoned tab on its own).
   */
  const applyToSession = async (tabId: number, gen: number, fn: (s: Session) => Session): Promise<void> => {
    const cur = sessionRef.current
    if (cur !== null && cur.tabId === tabId && genOf(tabId) === gen) {
      const next = fn(cur)
      sessionRef.current = next
      setSession(next)
      store.save(next)
      return
    }
    await mutateSession(tabId, (s) => (s === null || genOf(tabId) !== gen ? null : fn(s)))
  }

  /** S7: the latch is GLOBAL, so a re-scan due for another session waits its
   *  turn instead of multiplying paid resolves. */
  const queueRescan = (target: number): void => {
    runtimeOf(target).pendingRescan = true
    if (!rescanQueueRef.current.includes(target)) rescanQueueRef.current.push(target)
  }

  /** Drain ONE queued re-scan, oldest first (the next one drains when this scan
   *  releases the latch). A queued session that died or PARKED while it waited
   *  is dropped rather than run: a paid resolve against an SSO detour page,
   *  settling into a disabled session, is money spent on garbage. */
  const drainRescans = (): void => {
    while (!scanningRef.current && rescanQueueRef.current.length > 0) {
      const next = rescanQueueRef.current.shift()!
      const rt = runtimeOf(next)
      if (!rt.pendingRescan) continue
      rt.pendingRescan = false
      // For the DISPLAYED session, bumping the nonce (rather than calling onScan
      // here) re-runs the auto-scan effect, so the replay reads the current
      // render's state instead of the finishing scan's dead-page closure.
      if (tabIdRef.current === next) setScanNonce((n) => n + 1)
      else void onScan(next).catch(swallow)
      return
    }
  }

  /** Bind the panel to a session (or to the empty state) and reset everything
   *  that is per-session IN-FLIGHT: none of it belongs to the incoming session.
   *  The status line comes back from the session's own persisted `lastOutcome`,
   *  which is why that field is part of the stored shape. */
  const display = (s: Session | null): void => {
    showSession(s)
    if (s !== null) seedEpoch(s)
    lastOutcomeRef.current = s?.lastOutcome ?? null
    setScanStatus(s?.lastOutcome ?? null)
    setSubmitPrompt(false)
    setSaveMsg(null)
    setActing(null)
    setPicking(false)
    setMarking(false)
    setSaving(false)
    setGeneratingRefs(new Set())
    // NOT blanked: the batch belongs to the session, not to the screen. Blanking
    // here is what made a tab round-trip report "Generate all remaining" while
    // the batch was still running.
    setGenerateAll(s === null ? null : runtimeOf(s.tabId).generateAll)
    setGeneratePaused(s === null ? null : runtimeOf(s.tabId).generatePaused)
    setMarkedMsg(null)
  }

  /* ---------------------------------------------------------- render state */

  const fields = session?.fields ?? []
  const resolutions = session?.resolutions ?? []
  const edits = session?.edits ?? {}
  const generatedRefs = session?.generatedRefs ?? []
  const filledRefs = session?.filledRefs ?? []
  const election = session?.election ?? null
  const company = session?.company ?? ''
  const jobText = session?.jobText ?? ''
  const snapshot = session?.snapshot ?? {}
  const reuseOverrides = session?.reuseOverrides ?? {}
  const parked = session?.parked ?? false

  const { main, foreign } = buildRows(fields, resolutions, election?.frameId ?? null)
  // A8/A9: the SAME pure scorer scan.ts used decides which file row is wired to
  // the stored resume — recomputed over the CURRENT fields so a post-resume
  // re-enumeration can never leave the button on a stale fid.
  const resumeTargetField = pickResumeTarget(main.map((r) => r.field))
  const resumeTargetRef = resumeTargetField === null ? null : refOf(resumeTargetField)
  const companyOrNull = company.trim() === '' ? null : company.trim()

  // B6: facts-from-CV. null (no stored resume text) renders the button disabled.
  const onExtractFacts = cvText === null ? null : async (): Promise<Record<string, string> | null> => {
    const port = portRef.current
    if (port === null) return null
    const r = await port.request<Record<string, string>>('facts.extract', { cvText })
    if (!r.ok) { setHostError(hostErrorText(r.error)); return null }
    return r.result
  }

  /* ------------------------------------------------------------- lifecycle */

  useEffect(() => {
    const port = createHostPort()
    portRef.current = port
    port.onDisconnect(() => setHostError(ERROR_COPY.unreachable))
    void port.request<SelfCheck>('selfCheck', {}).then((r) => {
      if (r.ok) setCheck(r.result)
      else setHostError(hostErrorText(r.error))
    })
    return () => port.disconnect()
  }, [])

  /** An Accept/Fill/Pick that succeeded retires the red line its failed attempt
   *  left behind; anything the scan itself put there stays. */
  const clearActionFailure = (): void => {
    setScanStatus((s) => (s !== null && s.kind === 'action_failed' ? lastOutcomeRef.current : s))
  }

  /* ------------------------------------------------- S2/S5 session routing */

  /** Tab switch. Ordering is binding: save the OUTGOING session (the very object
   *  last displayed), flush it, and only THEN swap the display — otherwise the
   *  incoming render can race the outgoing write. No scan: re-scanning on every
   *  tab activation would spend one batched `claude -p` resolve per switch. */
  const swapTo = async (next: number): Promise<void> => {
    // Chrome re-activates the already-active tab in several flows; a repeat is a
    // no-op, never a re-swap. But "already on screen" is NOT "nothing in flight":
    // `tabIdRef` is assigned at the very END of a swap, so the user coming
    // straight back to the tab they left lands HERE while the swap toward the
    // other tab is still parked on its flush/load — and a bare return leaves that
    // swap's seq untouched, so it commits and displays a tab the user is not
    // looking at. Nothing repairs that: the tab on screen would be the ACTIVE
    // one, so no further `activated` is coming, and the next Scan would inject
    // and FILL the OTHER tab's page. Cancel the outbound swap instead.
    if (tabIdRef.current === next) {
      const heading = swapRef.current.target
      if (heading !== null && heading !== next) bumpSwap()
      return
    }
    const seq = bumpSwap(next)
    const outgoing = sessionRef.current
    if (outgoing !== null) {
      store.save(outgoing)
      await store.flush()
      if (seq !== swapRef.current.seq) return
    }
    const incoming = await store.load(next)
    if (seq !== swapRef.current.seq) return
    swapRef.current = { seq, target: null }
    tabIdRef.current = next
    setTabId(next)
    display(incoming)
  }

  const onTabRemoved = async (dead: number): Promise<void> => {
    const wasDisplayed = tabIdRef.current === dead
    // Chrome activates the successor tab BEFORE it emits `removed`, so when the
    // ACTIVE tab is closed a swap toward a different, LIVE tab is routinely
    // already in flight here. Invalidating it would strand the panel bound to the
    // tab that just died — and since the successor is already active, no further
    // `activated` is coming to repair it. So a removal invalidates only the work
    // that would put the REMOVED tab on screen; a swap heading elsewhere commits.
    const swapping = swapRef.current.target
    const swapIsRescue = swapping !== null && swapping !== dead
    if (!swapIsRescue && (wasDisplayed || swapping === dead)) bumpSwap()
    endRuntime(dead)
    lastNavRef.current.delete(dead)
    // F11: the tab is GONE — nothing will ever consult its runtime again except
    // a settle already in flight, and that settle is refused either way
    // (`genOf` answers null for a pruned tab). Dropping it here is what keeps
    // `runtimesRef` from growing for the whole life of the panel, one entry per
    // tab ever seen. Deliberately NOT done by `endRuntime`: Mark applied and
    // Discard end a session on a tab that stays OPEN and keeps navigating, and
    // that tab needs its runtime (and its bumped generation).
    runtimesRef.current.delete(dead)
    // Tombstones the session: no later save can bring the row back.
    await store.remove(dead)
    // The rescuing swap owns the display; blanking here would fight it (and lose
    // the empty state to a repaint a beat later anyway).
    if (wasDisplayed && !swapIsRescue && tabIdRef.current === dead) display(null)
  }

  /**
   * S7 constraint 6: a navigation on a tab NOBODY is looking at. The relay is
   * target-bound now, so its eventual re-scan reaches the right page and its
   * outcome routes to its own row — the visible panel never flickers.
   *
   * Classification runs INSIDE the mutate fn, which the store calls exactly once
   * on its lock: read, classify and write are then one atomic step against the
   * row that is really there (a load-then-write pair could classify against a
   * row another writer had already replaced).
   */
  const onNavigatedBackground = async (ev: { tabId: number; frameId: number; url: string }): Promise<void> => {
    const last = lastNavRef.current.get(ev.tabId)
    if (last !== undefined && last.url === ev.url && Date.now() - last.at < NAV_FALLBACK_DEDUPE_MS) return
    const rt = runtimeOf(ev.tabId)
    const acted = { rescan: false }
    await mutateSession(ev.tabId, (s) => {
      // A background tab with no session has nothing to route. Lazy creation on
      // a navigation is a DISPLAYED-tab affordance — that tab is the one the
      // user is applying on; minting a session for every background navigation
      // would fill session storage with pages nobody asked about.
      if (s === null) return null
      if (ev.frameId !== 0 && ev.frameId !== s.election?.frameId) return null
      lastNavRef.current.set(ev.tabId, { url: ev.url, at: Date.now() })
      const same = ev.url === '' || s.site === '' || sameSite(ev.url, s.startUrl)
      if (!same) {
        if (s.parked) return null
        rt.gen = nextGen()
        rt.navRescan = null
        // Drops a re-scan this session had already queued: parked pages never
        // spend a resolve.
        rt.pendingRescan = false
        return { ...s, parked: true }
      }
      rt.gen = nextGen()
      rt.navRescan = { prevFields: s.fields.length }
      acted.rescan = true
      return clearScanResults({ ...s, parked: false })
    })
    // onScan queues this behind the global latch when a scan is already running.
    if (acted.rescan) await onScan(ev.tabId)
  }

  const onNavigated = (ev: { tabId: number; frameId: number; url: string }): void => {
    if (tabIdRef.current !== ev.tabId) { void onNavigatedBackground(ev).catch(swallow); return }
    const last = lastNavRef.current.get(ev.tabId)
    if (last !== undefined && last.url === ev.url && Date.now() - last.at < NAV_FALLBACK_DEDUPE_MS) return
    const record = (): void => { lastNavRef.current.set(ev.tabId, { url: ev.url, at: Date.now() }) }

    // Lifecycle table: a session is created lazily on a Scan click OR a
    // navigation. A brand-new one has `site === ''`, so the empty-start exception
    // below classifies this nav as same-site and the re-scan captures the start
    // url — exactly the path a never-scanned tab needs.
    const s = sessionRef.current ?? newSession(ev.tabId)
    // S5 classification: a wizard step is the TOP frame or the ELECTED frame.
    // Any other subframe is page furniture (ads, chat widgets, payment iframes)
    // and must not touch the session.
    if (ev.frameId !== 0 && ev.frameId !== s.election?.frameId) return
    record()

    const rt = runtimeOf(ev.tabId)
    // Belt-and-braces over navSignals' url guard: an EMPTY url is NEVER a site
    // change — it must not park, unpark or rewrite `site`. A session that never
    // scanned (`site === ''`) has nothing to compare against, so the nav is
    // same-site and the next scan captures the start url.
    const same = ev.url === '' || s.site === '' || sameSite(ev.url, s.startUrl)

    if (!same) {
      // Idempotent: a second hop deeper into the same detour stays parked.
      if (s.parked) return
      rt.gen = nextGen()
      rt.navRescan = null
      rt.pendingRescan = false
      const nextSession = { ...s, parked: true }
      showSession(nextSession)
      // Session-suspending event: un-debounced, so the parked row survives a
      // panel close that follows immediately. The `swallow` sink is belt-and-braces
      // over `flush`'s own contract (it ABSORBS storage failure and resolves, which
      // sessions.test.ts pins): chrome.storage rejects on an invalidated extension
      // context, and a floating rejection at teardown is a console error, not a
      // diagnosis. Every other `void`ed promise in this file carries the same sink.
      store.save(nextSession)
      void store.flush().catch(swallow)
      setScanStatus(null)
      lastOutcomeRef.current = null
      setSubmitPrompt(false)
      setMarkedMsg(null)
      return
    }

    // Same site: the session survives the step (and a parked one comes home).
    rt.gen = nextGen()
    rt.navRescan = { prevFields: s.fields.length }
    const nextSession = clearScanResults({ ...s, parked: false })
    showSession(nextSession)
    store.save(nextSession)
    setSubmitPrompt(false)
    setMarkedMsg(null)
    // A scan still draining cannot be cancelled (host-protocol change, deferred
    // to a future slice), and its own writes are dropped — so a blank line here
    // is minutes of a frozen-looking panel. Say what is being waited on instead.
    setScanStatus(scanningRef.current ? { kind: 'superseded' } : null)
    lastOutcomeRef.current = null
    setScanNonce((n) => n + 1)
  }

  const onNavEvent = (e: NavEvent): void => {
    if (e.type === 'activated') {
      if (overrideModeRef.current) return
      void swapTo(e.tabId)
      return
    }
    if (e.type === 'removed') { void onTabRemoved(e.tabId); return }
    onNavigated(e)
  }

  useEffect(() => {
    let cancelled = false
    let stop: (() => void) | null = null
    // ?tabId= lets the e2e smoke drive the panel as an ordinary page; the real
    // side panel binds to the active tab of its own window.
    const override = new URLSearchParams(location.search).get('tabId')
    overrideModeRef.current = override !== null

    const boot = async (): Promise<void> => {
      let windowId = -1
      try { windowId = (await chrome.windows.getCurrent()).id ?? -1 } catch { /* no window api */ }
      if (cancelled) return
      let bound = override === null ? null : Number(override)
      if (bound === null) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
        bound = tabs[0]?.id ?? null
      }
      if (cancelled) return
      if (bound !== null) {
        // Rehydrate + prune BEFORE anything can scan. `prune` TOMBSTONES every
        // non-live tab it sweeps, so a session the mount auto-scan created while
        // the sweep was in flight would be silently dropped and never recreated
        // — which is why `booted` (not `tabId`) is what unlocks the auto-scan
        // effect below.
        const live = new Set<number>([bound])
        let enumerated = true
        try {
          for (const t of await chrome.tabs.query({})) { if (t.id !== undefined) live.add(t.id) }
        } catch { enumerated = false }
        if (cancelled) return
        // Pruning against a FAILED enumeration is not conservative, it is the
        // worst case: `live` would be just the bound tab, so the sweep would
        // delete AND tombstone every other session — live parked applications in
        // other windows included. A row that outlives its tab costs storage; a
        // wrong sweep costs the user's work. Skip the sweep entirely.
        if (enumerated) await store.prune(live)
        if (cancelled) return
        const restored = await store.load(bound)
        if (cancelled) return
        tabIdRef.current = bound
        setTabId(bound)
        display(restored)
      }
      try { stop = createNavSignals(windowId, onNavEvent) } catch { /* no navigation apis */ }
      setBooted(true)
    }
    void boot()
    return () => { cancelled = true; if (stop !== null) stop() }
  }, [])

  // S6 durability. Be honest about what each layer buys: the `pagehide` flush is
  // BEST-EFFORT ONLY — MV3 cannot keep a closing document alive for an async
  // completion, so that write may not finish. Real durability comes from the
  // continuous debounced persistence (at most SESSION_SAVE_DEBOUNCE_MS behind)
  // plus the visibilitychange:'hidden' flush, which fires EARLIER in every
  // close/switch sequence.
  useEffect(() => {
    const flushNow = (): void => {
      const s = sessionRef.current
      if (s !== null) store.save(s)
      // Same belt-and-braces sink as the park arm: this handler runs on the way
      // out, which is exactly where chrome.storage starts rejecting.
      void store.flush().catch(swallow)
    }
    const onVisibility = (): void => { if (document.visibilityState === 'hidden') flushNow() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flushNow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flushNow)
    }
  }, [])

  useEffect(() => {
    void Promise.all([loadResume(), loadResumeText()])
      .then(([r, text]) => { setResumeName(r?.name ?? null); setCvText(text); setResumeOk(true) })
      .catch(() => { setResumeName(null); setCvText(null); setResumeOk(false) })
  }, [])

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
      setFactsOk(p.ok && b.ok)
    })
  }, [check])

  // Snapshot pushes arrive stamped by the SERVICE WORKER with the sender's
  // tabId/frameId (the content script can know neither). S7: the stamp is
  // ROUTING, not a filter — `m.tabId` is compared against the sessions, not
  // against the active tab, so a background form's snapshot reaches ITS row
  // instead of being thrown away. Stale epochs are still rejected: handles from
  // an old scan must never leak into a save. The service worker's own
  // storage.session fallback (`jff:snap:*`) is untouched by any of this.
  useEffect(() => {
    const onMsg = (raw: unknown): void => {
      const m = raw as { kind?: string; tabId?: number; frameId?: number; snap?: { epoch: number; values: Record<number, string> } }
      if (m?.kind !== 'snapshotPush' || m.snap === undefined || typeof m.tabId !== 'number') return
      const tabId = m.tabId
      const epoch = m.snap.epoch
      const frameId = m.frameId ?? 0
      const values = m.snap.values
      const merge = (cur: Session): Session => {
        const next = { ...cur.snapshot }
        for (const [fid, v] of Object.entries(values)) next[`${frameId}:${fid}`] = v
        return { ...cur, snapshot: next }
      }
      const s = sessionRef.current
      if (s !== null && s.tabId === tabId) {
        if (epoch === s.epoch) writeSession(merge)
        return
      }
      // Background: the epoch check runs against the row `fn` is handed
      // (stored-or-pending), because only that row knows which scan it describes.
      void mutateSession(tabId, (row) => (row === null || row.epoch !== epoch ? null : merge(row))).catch(swallow)
    }
    chrome.runtime.onMessage.addListener(onMsg)
    return () => chrome.runtime.onMessage.removeListener(onMsg)
  }, [])

  // B1, the repair path back to the screen: a BACKGROUND write for a tab that is
  // (or has just become) the displayed one re-projects the display from the row
  // that was actually written. Without it a background→foreground swap racing a
  // mutate leaves screen and storage silently divergent — the swap's load and
  // the mutate are both on the store's FIFO lock, and whichever enqueues second
  // wins its own copy.
  useEffect(() => store.onWrite((writtenTabId, written) => {
    if (!bgWriteRef.current.has(writtenTabId)) return
    if (sessionRef.current === null || sessionRef.current.tabId !== writtenTabId) return
    showSession(written)
    lastOutcomeRef.current = written.lastOutcome
    setScanStatus(written.lastOutcome)
  }), [])

  useEffect(() => () => { mountedRef.current = false }, [])

  /* --------------------------------------------------------------- actions */

  /**
   * `target` is EXPLICIT — never read from `tabIdRef` — because the display
   * binding is mutable now and this runs after an await. Every message goes to
   * the tab its operation was DISPATCHED for: an enumeration, snapshot or
   * JFF_FILL belonging to a scan that started on tab 7 must still reach tab 7
   * when the user switches to tab 8 mid-scan. The `inScope` guards drop the
   * RESULT of out-of-scope work, but a message resolved against the CURRENT
   * display would already have been delivered — and JFF_FILL writes to the page.
   */
  const sendToTab = async (target: number, frameId: number | undefined, message: ContentMessage): Promise<SendResult> => {
    const res = await chrome.runtime.sendMessage({ kind: 'toContent', tabId: target, frameId, message }) as
      { ok?: boolean; error?: string; replies?: FrameReply[]; failures?: RelayFailure[] } | undefined
    // A relay that answers ok:false — or does not answer at all — is a failure the
    // user must SEE. The old `?? []` here is how three real failure modes rendered
    // as "nothing happened".
    if (res?.ok !== true) throw new Error(res?.error ?? 'The extension background did not answer.')
    return { replies: res.replies ?? [], failures: res.failures ?? [] }
  }

  /** chrome.tabs.get REJECTS once the bound tab is gone; every caller here runs
   *  from an event the user does not control. `target` is explicit for the same
   *  reason as `sendToTab`: the tab whose url/title an operation is asking about
   *  is the one it was dispatched for, not the one that happens to be on screen. */
  const getTab = async (target: number): Promise<chrome.tabs.Tab | null> => {
    try { return await chrome.tabs.get(target) } catch { return null }
  }

  /** S4: every displayed-row answer is written TWICE — ref-keyed into `edits`,
   *  which the page and the save diff speak, and label-keyed into `answers`,
   *  which is what survives the next re-enumeration. */
  const onEdit = (ref: string, value: string): void => {
    writeSession((s) => rememberAnswer({ ...s, edits: { ...s.edits, [ref]: value } }, ref, value, 'user'))
  }

  /**
   * S7: `targetTabId` is the tab this scan is FOR. It defaults to the displayed
   * tab (the auto-scan effect and the Scan button), and a queued background
   * re-scan passes its own. Everything the scan touches — the relay triple, the
   * epoch source, every settling write — is bound to it at dispatch time and
   * NEVER re-read from a live ref, which is what keeps a JFF_FILL for tab 7 off
   * tab 8's page after a mid-scan switch.
   */
  const onScan = async (targetTabId?: number): Promise<void> => {
    const port = portRef.current
    const target = targetTabId ?? tabIdRef.current
    if (port === null || target === null) return
    // O3: no scan may fire while the profile verdict is undecided or the host
    // gate is shut — including the ones the button and the nav-driven re-scans
    // reach directly, which never passed through the auto-scan effect's check.
    // Not queued: there is nothing to replay to. The gate opening is itself a
    // scan trigger (the auto-scan effect keys on it).
    if (!scanGateRef.current) return
    if (scanningRef.current) {
      // Dropping this trigger silently is how a mid-scan navigation left the new
      // page unscanned forever. The latch is GLOBAL, so this queues across
      // sessions too; the running scan drains it FIFO when it finishes.
      queueRescan(target)
      return
    }
    const displayed = tabIdRef.current === target
    const shown = sessionRef.current
    // S5: a parked session's page is a detour (an SSO login form), not the
    // application — scanning it would spend a paid resolve on garbage.
    if (displayed && shown !== null && shown.tabId === target && shown.parked) return
    // Busy state and re-entry guard flip TOGETHER, before any await: between them
    // the scan is already committed while the button would still read 'Scan'.
    scanningRef.current = true
    setScanning(true)
    // B8: at most ONE [data-jff-applied] node ever renders. Clearing the
    // transient post-mark confirmation HERE closes the post-mark → Scan →
    // check-hit overlap window.
    if (displayed) setMarkedMsg(null)
    const rt = runtimeOf(target)
    // Every write below is conditional on this still being the current (tab,
    // generation) pair — and lands in THIS tab's session either way.
    const sc = { target, gen: rt.gen }
    try {
      // A queued re-scan for a session that is not on screen must prove the
      // session is still there and still eligible: a row that was removed or
      // parked while it waited in the queue gets no paid resolve.
      let existing = shown !== null && shown.tabId === target ? shown : null
      if (!displayed) {
        existing = await store.load(target)
        if (existing === null || existing.parked || !alive(sc)) return
      }
      const tab = await getTab(target)
      // The tab closed between the trigger and here — this replay is a dead end.
      // A lingering 'superseded' from the reset that queued this replay would
      // otherwise promise a rescan that is never coming.
      if (tab === null) {
        if (inScope(sc)) setScanStatus((s) => (s !== null && s.kind === 'superseded' ? null : s))
        return
      }
      // A tab SWITCH no longer aborts: only this session's own death does.
      if (!alive(sc)) return
      const url = tab.url ?? ''
      // The session exists BEFORE the applied.check (ordering rule 2b): a badge
      // hit needs a row to land in, or A4's primary fresh-tab scenario writes the
      // badge into a session that does not exist yet and never renders it.
      if (existing === null) {
        // A2: the FIRST scanned page of this application is the posting URL
        // applied.mark records — wizard step 2's URL is not the posting.
        const fresh = newSession(target, url)
        seedEpoch(fresh)
        // `save` is the creation path: `mutate` is not, and would be refused
        // outright on a tab whose previous session was marked or discarded.
        if (tabIdRef.current === target && sessionRef.current === null) startSession(fresh)
        else store.save(fresh)
      } else {
        seedEpoch(existing)
        await applyToSession(target, sc.gen, (s) => ({
          ...s,
          startUrl: s.startUrl === '' ? url : s.startUrl,
          site: s.startUrl === '' ? registrableDomain(url) : s.site,
          // The badge described a page; this scan re-decides it.
          appliedHit: null,
        }))
      }
      // A4: the applied badge outranks the scan itself — but never the user's
      // explicit override, and a check FAILURE proceeds as not-applied (spec,
      // Error handling). Precedence: onboarding gate (the auto-scan effect
      // never calls us while incomplete) > host gate (gateOpen — this check IS
      // a host call, so it necessarily runs after it) > this badge > scan.
      // `?? null` is load-bearing: the canned fake answers unknown methods {},
      // and an `undefined` here must read as a MISS, never as a hit.
      if (!rt.appliedOverride) {
        const chk = await port.request<{ applied: { markedAt: string } | null }>('applied.check', { url })
        // The sibling of Task 5's stale-action race: this round-trip is hundreds
        // of ms wide, and the badge it decides belongs to the page it asked
        // about. A dead generation drops it; a swapped display routes it.
        if (!alive(sc)) return
        const hit = chk.ok ? (chk.result.applied ?? null) : null
        if (hit !== null) {
          await applyToSession(target, sc.gen, (s) => ({ ...s, appliedHit: { markedAt: hit.markedAt } }))
          if (inScope(sc)) setScanStatus(null)
          return
        }
      }
      // A previous application on this same tab may have left snapshot rows in
      // storage.session; they must never merge into this scan's save. The
      // SNAPSHOT_KEY_RE filter is what keeps this off the jff:session:* rows now
      // sharing the area (their disjointness is a tested invariant).
      const staleKeys = Object.keys(await chrome.storage.session.get(null))
        .filter((k) => { const m = SNAPSHOT_KEY_RE.exec(k); return m !== null && Number(m[1]) === target })
      if (staleKeys.length > 0) await chrome.storage.session.remove(staleKeys)

      const hostname = hostnameOf(url)
      // A3 trigger: this scan replays a NAVIGATION the session survived. The
      // same-site question was already ANSWERED by the nav classifier (S5,
      // registrable domain over the EVENT url) — only a same-site step queues a
      // re-scan, so a pending nav here IS the same-site case. This replaces the
      // pre-sessions same-hostname approximation.
      const pendingNav = rt.navRescan
      rt.navRescan = null
      const sameSiteNav = pendingNav !== null
      // Company: the user's edit always wins; guess only while the field is empty.
      // Read from the session this scan OWNS, never from whatever is on screen.
      const ownedSession = (): Session | null =>
        sessionRef.current !== null && sessionRef.current.tabId === target ? sessionRef.current : existing
      const known = ownedSession()?.company.trim() ?? ''
      const co = known === '' ? guessCompany(tab.title ?? '', hostname) : known
      // Post-await writes, and the mid-scan window they sit in is hundreds of ms
      // wide: tab 7's guess belongs in tab 7's storage, never on tab 8's screen.
      if (co !== null && known === '' && alive(sc)) {
        await applyToSession(target, sc.gen, (s) => ({ ...s, company: co, companyGuessed: true }))
      }
      if (alive(sc)) await applyToSession(target, sc.gen, (s) => ({ ...s, frameReports: [] }))
      const out = await runScan({
        nextEpoch: () => {
          const next = ++rt.epoch
          void applyToSession(target, sc.gen, (s) => ({ ...s, epoch: next })).catch(swallow)
          return next
        },
        inject: async () => {
          const r = await chrome.runtime.sendMessage({ kind: 'inject', tabId: target }) as
            { ok?: boolean; error?: string; frames?: number[] } | undefined
          if (r?.ok !== true) throw new Error(r?.error ?? 'Could not reach the page.')
          return r.frames ?? []
        },
        // Bound to THIS scan's tab, so every message it relays stays pinned to
        // the page the scan was dispatched for.
        sendToTab: (frameId, message) => sendToTab(target, frameId, message),
        onProgress: (p: ScanProgress) => {
          if (!inScope(sc)) return
          setScanStatus(
            p.phase === 'enumerating' ? { kind: 'enumerating', frames: p.frames }
            : p.phase === 'resolving' ? { kind: 'resolving', fields: p.fields }
            : { kind: p.phase },
          )
        },
        // The enumeration retry's only cancellation point: a scan whose session
        // navigated or died — or a panel that unmounted — stops here instead of
        // firing a real inject + JFF_SCAN 1.5s into a page it no longer describes.
        sleep: (ms: number) => new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            if (!mountedRef.current || !alive(sc)) reject(new Error(SCAN_ABORTED))
            else resolve()
          }, ms)
        }),
        port,
        getResume: loadResume,
        pastedJobText: ownedSession()?.jobText ?? '',
        hostname,
        url,
        company: co,
      })
      // The bound tab navigated or closed while this scan ran: these fields,
      // resolutions and counts describe a page that is gone, and every JFF_FILL
      // they claim was answered stale_epoch. Drop the whole write. A DISPLAY
      // swap is not that — the results are still true of tab 7, so they go to
      // tab 7's row instead of the screen.
      if (!alive(sc)) return
      // B3: a resolution whose batched auto-fill the page REJECTED is not
      // "filled" — demote it to needs_input carrying the fill reason, so the
      // row drops to needs-input styling, REASON_HINT renders the hint
      // (choice-needs-user-click → "Select this answer on the page yourself."),
      // and the user gets Generate/Fill to recover. Page-sourced rows are never
      // in `failed` (the loop skips them), so `already on page` is untouched.
      const failedFillReason = new Map(out.fill.failed.map((f) => [refOf(f.handle), f.reason]))
      const settled = out.resolutions.map((r) =>
        failedFillReason.has(refOf(r.handle))
          ? { ...r, tier: 'needs_input' as const, reason: failedFillReason.get(refOf(r.handle))! }
          : r)
      // B1c: the batch fill is authoritative for EVERY ref it put a value on, not
      // just the ones the page rewrote. `committed` is the page's canonical text
      // where it canonicalized ('bra' → 'Brazil') and NULL where the page took the
      // sent value verbatim — both mean the same thing, "this is what the page
      // holds now". Seeding only the canonicalized half is how a verbatim fill
      // stayed absent here and let S4's carry re-seed the row (and the save diff)
      // with a stale answer for a field the page had just filled. The row, the
      // save diff and the choice highlight all speak the page's language.
      const sentValue = new Map(settled.map((r) => [refOf(r.handle), r.value]))
      const committedEdits: Record<string, string> = {}
      for (const f of out.fill.filled) {
        const ref = refOf(f.handle)
        // A null `committed` with no resolution value behind it is unreachable
        // through runScan (it only batch-fills resolutions whose value is a
        // non-empty string). If it ever happens we have NO evidence of what the
        // page holds, so seed nothing: a '' here would blank the row AND suppress
        // the carry, asserting an emptiness nobody observed.
        const value = f.committed ?? sentValue.get(ref) ?? null
        if (value !== null) committedEdits[ref] = value
      }
      // A9/B3 status semantics: `filled` = PAGE-ACCEPTED batched fills, straight
      // from the frames' JFF_FILL reports — never inferred from tiers, so a
      // failed batch can never inflate it. `already on page` = page-sourced
      // values the engine never wrote. The remaining counts run over the
      // DEMOTED array so the four numbers always describe the rows on screen.
      const filled = out.fill.filled.length
      const alreadyOnPage = settled.filter((r) => r.tier === 'auto' && r.source === 'page').length
      const proposed = settled.filter((r) => r.tier === 'proposed').length
      const needsInput = settled.filter((r) => r.tier === 'needs_input').length
      // Precedence: captcha > empty > llm failure > done. A captcha'd page may
      // also be field-less; the captcha is the actionable fact.
      const outcome: ScanUiState =
        out.activeCaptcha ? { kind: 'captcha' }
        // DISTINCT frames: a frame that errored first-pass and replied on the retry
        // contributes two reports but is still one frame on the page.
        : out.fields.length === 0 ? { kind: 'empty', frames: new Set(out.frameReports.map((r) => r.frameId)).size }
        : out.llmError !== null ? { kind: 'failed', reason: hostErrorText(out.llmError) }
        : { kind: 'done', filled, alreadyOnPage, proposed, needsInput }
      if (inScope(sc)) { lastOutcomeRef.current = outcome; setScanStatus(outcome) }
      // S4: the ONE projection. Everything ref-keyed dies with the page the scan
      // replaced; the label-keyed carry re-attaches onto whatever refs the new
      // enumeration handed the same questions, and `committedEdits` outranks it.
      // The background settle runs the SAME function inside store.mutate — a
      // second implementation would be a second copy of the never-guess rules.
      await applyToSession(target, sc.gen, (s) => ({
        ...projectAnswers(s, out.fields, settled, committedEdits),
        election: out.election,
        unreachable: out.unreachableWidgets,
        activeCaptcha: out.activeCaptcha,
        frameReports: out.frameReports,
        jobText: out.jobText !== '' ? out.jobText : s.jobText,
        lastOutcome: outcome,
      }))
      if (out.llmError !== null) setHostError(hostErrorText(out.llmError))
      // A3: detection is only ever a PROMPT, and only for the session ON SCREEN
      // — a background tab has no panel to prompt in. Best-effort page text; a
      // dead relay just means the field-count heuristic decides alone.
      if (sameSiteNav && rt.promptDismissedGen !== sc.gen && inScope(sc) && sessionRef.current?.appliedHit == null) {
        let pageText = ''
        try {
          const { replies } = await sendToTab(target, 0, { type: 'JFF_PAGETEXT', epoch: out.epoch })
          const p = replies[0]?.payload as { ok?: boolean; pageText?: string } | undefined
          if (p?.ok === true) pageText = p.pageText ?? ''
        } catch { /* best-effort */ }
        if (!inScope(sc)) return
        if (detectSubmission({ prevFields: pendingNav!.prevFields, newFields: out.fields.length, pageText })) {
          setSubmitPrompt(true)
        }
      }
    } catch (e) {
      // The retry's abort is not a failure to report — the page it described is
      // gone, and so is the panel in the unmount case.
      if (e instanceof Error && e.message === SCAN_ABORTED) return
      // Same rule as the success path: a dead generation's failure is not this
      // page's failure — but a live one's IS, wherever that session now lives.
      if (!alive(sc)) return
      const reason = e instanceof Error ? e.message : String(e)
      const outcome: ScanUiState = { kind: 'failed', reason }
      // Synthetic relay report (frameId -1): without it the diagnostics
      // disclosure could NEVER render for inject/broadcast failures, because
      // frameReports was cleared at scan start. ScanStatus renders -1 as "relay".
      // A ScanError died AFTER enumerating, so its evidence is kept and the
      // synthetic row APPENDED to it, never substituted for it.
      const relayRow: FrameReport = { frameId: -1, url: null, fields: null, error: reason }
      const reports = e instanceof ScanError ? [...e.frameReports, relayRow] : [relayRow]
      if (inScope(sc)) { lastOutcomeRef.current = outcome; setScanStatus(outcome) }
      await applyToSession(target, sc.gen, (s) => ({ ...s, lastOutcome: outcome, frameReports: reports }))
    } finally {
      scanningRef.current = false
      if (mountedRef.current) {
        setScanning(false)
        // The latch is free: hand it to the oldest queued re-scan, in ANY
        // session. A trigger this run swallowed is in that queue too.
        drainRescans()
      }
    }
  }

  // Auto-scan on open and after the displayed tab NAVIGATES same-site (a wizard
  // step is new DOM). Keyed on `booted`, never on `tabId`: a tab SWITCH changes
  // tabId and must NOT scan — it would spend one batched `claude -p` resolve per
  // switch. `hostAnswered` latches false->true ONCE (selfCheck answers or fails);
  // keying on `hostError` directly would re-fire the auto-scan every time a later
  // host error (e.g. an llmError) sets it — an accidental scan loop.
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

  // O3 deadline, anchored ONCE at mount: a port that never answers must not
  // pin a fresh panel on 'pending' forever, and a PARTIAL settle must not
  // restart the clock. Past the deadline an unsettled decision becomes
  // 'unknown' (normal panel + banner) — the gate can ONLY ever be shown by a
  // successful load proving incompleteness.
  useEffect(() => {
    const timer = setTimeout(() => setCompleteness((c) => (c === 'pending' ? 'unknown' : c)), hostWaitMs)
    return () => clearTimeout(timer)
  }, [])

  // O3: the completeness decision LATCHES on its first settled verdict — a
  // facts load limping in after the deadline must not flip a working panel
  // into (or out of) onboarding mid-session. Only Finish moves it afterwards.
  useEffect(() => {
    if (completeness !== 'pending') return
    if (factsOk !== null && resumeOk !== null) {
      setCompleteness(profileCompleteness(facts, resumeName !== null, factsOk && resumeOk))
    }
  }, [factsOk, resumeOk, completeness])

  /**
   * O3: "the gate means no scan triggers" — and until this existed only the
   * AUTO-scan honoured it. While the decision is 'pending' the normal scan UI
   * still rendered (the onboarding wall only replaces it on a PROVEN
   * 'incomplete'), with a live Scan button that would spend a paid `claude -p`
   * resolve against a profile with no resume and no facts, draining into a
   * session the wall then hides. Both the button and `onScan` read this.
   *
   * Brick-safety is untouched: past the hostWaitMs deadline the latch opens and
   * the decision becomes 'unknown', which is not 'pending' — so a dead host
   * REOPENS the gate rather than sealing it.
   *
   * Assigned during render on purpose: an effect would let the auto-scan effect
   * below observe a stale ref within the same commit.
   */
  const scanGateOpen = gateOpen && completeness !== 'pending'
  scanGateRef.current = scanGateOpen

  useEffect(() => {
    if (!booted) return
    if (!scanGateOpen) { setScanStatus({ kind: 'connecting' }); return }
    // O3: a profile PROVEN incomplete renders OnboardingView instead of scan UI
    // — no scan may fire. 'unknown' scans anyway: a dead host must never brick
    // an existing user (they see the normal panel plus the host banner).
    if (completeness === 'incomplete') return
    void onScan()
  }, [booted, scanNonce, gateOpen, completeness])

  /** Put one value on the page. Shared by Accept and Fill; what they additionally
   *  CONFIRM is the only difference between them. THROWS if the relay or the
   *  frame refused the fill — callers must not confirm anything on a throw.
   *  Returns the page-accepted canonical text when it differs from what was
   *  sent (B1c: 'bra' commits 'Brazil'), else null. */
  const fillOne = async (target: number, row: Row, value: string): Promise<string | null> => {
    if (value === '') return null
    const { replies } = await sendToTab(target, row.field.frameId, {
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
    const sc = scopeNow()
    if (row === undefined || acting !== null || sc === null) return
    const value = edits[ref] ?? row.resolution.value ?? ''
    if (value === '') return
    // Same rule as the scan: this row, this value and this failure all describe the
    // page the click was made on. A JFF_FILL answering after a navigation is about
    // a dead page — its verdict must reach neither the status line nor the rows.
    setActing({ ref, action: 'accept' })
    try {
      const committed = await fillOne(sc.target, row, value)
      if (!alive(sc)) return
      // Promote the TIER only. Writing `value` back onto the resolution would make
      // engine === final in buildSaveItems and silently drop every user correction
      // to a proposed answer. The edit lives in `edits`, where the save diff reads it.
      // S4: what the PAGE took is the answer worth carrying — committed text wins.
      await applyToSession(sc.target, sc.gen, (s) => rememberAnswer({
        ...s,
        edits: committed === null ? s.edits : { ...s.edits, [ref]: committed },
        resolutions: s.resolutions.map((r) => (refOf(r.handle) === ref ? { ...r, tier: 'auto' as const } : r)),
      }, ref, committed ?? value, 'user'))
      // Accepting an AI key match IS the user confirmation the spec's
      // learned_mappings flow needs: promote it to a deterministic mapping.
      if (row.resolution.source === 'llm_key' && row.resolution.key !== null && row.field.label !== null) {
        void portRef.current?.request('mapping.confirm', { label: row.field.label, fieldKey: row.resolution.key })
      }
      if (inScope(sc)) clearActionFailure()
    } catch (e) {
      if (!inScope(sc)) return
      setScanStatus({ kind: 'action_failed', reason: `Accept failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      if (tabIdRef.current === sc.target) setActing(null)
    }
  }

  /** Closes the spec's [Generate] loop: draft, edit, then put it on the page.
   *  Unlike Accept this confirms no mapping and promotes no tier — a needs-input
   *  row has no LLM-proposed key, only an answer the user wrote. */
  const onFill = async (ref: string): Promise<void> => {
    const row = [...main, ...foreign].find((r) => r.ref === ref && r.resolution.tier === 'needs_input') // onFill
    const sc = scopeNow()
    if (row === undefined || acting !== null || sc === null) return
    const value = edits[ref] ?? row.resolution.value ?? ''
    if (value.trim() === '') return
    // A ref is `frameId:fid` — it carries no epoch, so the NEW page's field 0:1
    // would wear a dead page's "on the page" badge without this.
    setActing({ ref, action: 'fill' })
    try {
      const committed = await fillOne(sc.target, row, value)
      if (!alive(sc)) return
      await applyToSession(sc.target, sc.gen, (s) => rememberAnswer({
        ...s,
        edits: committed === null ? s.edits : { ...s.edits, [ref]: committed },
        filledRefs: s.filledRefs.includes(ref) ? s.filledRefs : [...s.filledRefs, ref],
      }, ref, committed ?? value, 'user'))
      if (inScope(sc)) clearActionFailure()
    } catch (e) {
      if (!inScope(sc)) return
      setScanStatus({ kind: 'action_failed', reason: `Fill failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      if (tabIdRef.current === sc.target) setActing(null)
    }
  }

  /** A9: put the stored resume on the A8-winning file row, targeting ITS fid
   *  through the existing base64 JFF_FILL_RESUME plumbing. */
  const onFillResume = async (ref: string): Promise<void> => {
    const row = main.find((r) => r.ref === ref)
    const sc = scopeNow()
    if (row === undefined || sc === null || acting !== null) return
    const resume = await loadResume()
    if (resume === null) return
    setActing({ ref, action: 'fill' })
    try {
      const { replies } = await sendToTab(sc.target, row.field.frameId, {
        type: 'JFF_FILL_RESUME', epoch: row.field.epoch,
        handle: { frameId: row.field.frameId, fid: row.field.fid, epoch: row.field.epoch },
        fileName: resume.name, mimeType: resume.mimeType, dataBase64: resume.dataBase64,
      })
      if (!alive(sc)) return
      const p = replies[0]?.payload as { ok?: boolean; error?: string } | undefined
      if (p?.ok !== true) throw new Error(p?.error ?? 'the page rejected the file')
      await applyToSession(sc.target, sc.gen, (s) => ({ ...s, filledRefs: s.filledRefs.includes(ref) ? s.filledRefs : [...s.filledRefs, ref] }))
      if (inScope(sc)) clearActionFailure()
    } catch (e) {
      if (!inScope(sc)) return
      setScanStatus({ kind: 'action_failed', reason: `Resume fill failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      if (tabIdRef.current === sc.target) setActing(null)
    }
  }

  /** One generate round-trip for one row. Returns 'ok', 'skipped' (no such
   *  row / no port / already running), 'aborted' (the page died mid-flight),
   *  or the host error kind — the batch loop dispatches on it. */
  const generateOne = async (ref: string): Promise<'ok' | 'skipped' | 'aborted' | HostErrorKind> => {
    const row = main.find((r) => r.ref === ref && r.resolution.tier === 'needs_input')  // foreign rows never generate
    const port = portRef.current
    const sc = scopeNow()
    if (row === undefined || port === null || sc === null || generatingRefs.has(ref)) return 'skipped'
    // Same rule as Accept/Fill: a draft answering a DEAD page's question must
    // never land in edits (spec D3).
    setGeneratingRefs((s) => new Set(s).add(ref))
    try {
      const r = await port.request<{ draft: string }>('generate', {
        handle: row.resolution.handle,
        questionRaw: row.field.label ?? '',
        description: row.field.description,
        jobText,
        company: companyOrNull,
        ...(cvText === null ? {} : { cvText }),
      })
      // Only the OWNING session's death aborts a draft — a tab switch just means
      // it settles into storage. Two rows on two sessions can be generating at
      // once and their drafts must never cross.
      if (!alive(sc)) return 'aborted'
      if (r.ok) {
        const draft = r.result.draft
        // S4: a settled draft is carried with provenance 'generated', which is
        // what re-enters generatedRefs on the next step.
        await applyToSession(sc.target, sc.gen, (s) => rememberAnswer({
          ...s,
          edits: { ...s.edits, [ref]: draft },
          generatedRefs: s.generatedRefs.includes(ref) ? s.generatedRefs : [...s.generatedRefs, ref],
        }, ref, draft, 'generated'))
        return 'ok'
      }
      setHostError(hostErrorText(r.error))
      return r.error.kind
    } finally {
      setGeneratingRefs((s) => { const next = new Set(s); next.delete(ref); return next })
    }
  }

  const onGenerate = async (ref: string): Promise<void> => { await generateOne(ref) }

  /** B4 eligibility: needs-input, labelled, nothing drafted/edited yet, not
   *  currently generating. Foreign rows are structurally absent from `main`. */
  const generateEligible = main.filter((r) =>
    r.resolution.tier === 'needs_input'
    && (r.field.label ?? '').trim() !== ''
    && (edits[r.ref] ?? '').trim() === ''
    && !generatedRefs.includes(r.ref)
    && !generatingRefs.has(r.ref))

  const TERMINAL_GENERATE_KINDS: ReadonlySet<string> = new Set(['not_installed', 'not_authed', 'rate_limit'])

  /** Mirror per-session batch state into the runtime, and onto the screen only
   *  while that session is the one being displayed. */
  const showGenerateAll = (target: number, v: { done: number; total: number } | null): void => {
    runtimeOf(target).generateAll = v
    if (tabIdRef.current === target) setGenerateAll(v)
  }
  const showGeneratePaused = (target: number, v: { done: number; total: number } | null): void => {
    runtimeOf(target).generatePaused = v
    if (tabIdRef.current === target) setGeneratePaused(v)
  }

  const onGenerateAll = async (): Promise<void> => {
    if (generateAll !== null) return
    const refs = generateEligible.map((r) => r.ref)
    const sc = scopeNow()
    if (refs.length === 0 || sc === null) return
    showGeneratePaused(sc.target, null)
    let done = 0
    try {
      for (let i = 0; i < refs.length; i++) {
        // The batch is bound to the DISPLAYED session: generateOne resolves its
        // row out of `main` and its scope out of `scopeNow`, both of which
        // follow the screen. So leaving the session ENDS the batch — say where
        // it stopped, so the user can resume instead of guessing. A dead page
        // (re-scan, navigation) is different: those refs describe nothing, and
        // `alive` below distinguishes it from a mere tab switch.
        if (!inScope(sc)) {
          if (alive(sc)) showGeneratePaused(sc.target, { done, total: refs.length })
          return
        }
        showGenerateAll(sc.target, { done: i, total: refs.length })
        const out = await generateOne(refs[i]!)
        if (out === 'aborted') return
        // Terminal host problems affect every remaining row identically; the
        // banner is already up (generateOne set it). Transient per-row failures
        // ('timeout', 'process', …) skip the row and continue.
        if (TERMINAL_GENERATE_KINDS.has(out)) return
        done = i + 1
      }
    } finally {
      showGenerateAll(sc.target, null)
    }
  }

  const onPickJobText = async (): Promise<void> => {
    const owner = sessionRef.current
    if (owner === null || fields.length === 0 || picking) return
    const sc = { target: owner.tabId, gen: runtimeOf(owner.tabId).gen }
    // The picked text — and the selector learned from it — describe the page the
    // pick started on; everything below this await is dropped once that page is gone.
    setPicking(true)
    try {
      // Always settles: click, Escape (pick_cancelled) or timeout. The epoch is
      // the SESSION's, never a panel-global.
      const { replies } = await sendToTab(sc.target, 0, { type: 'JFF_PICK', epoch: owner.epoch })
      if (!alive(sc)) return
      const p = replies[0]?.payload as { ok: boolean; pick?: { selector: string; text: string } } | undefined
      if (p?.ok !== true || p.pick === undefined) return // cancelled; leave the paste box alone
      const picked = p.pick
      await applyToSession(sc.target, sc.gen, (s) => ({ ...s, jobText: picked.text }))
      if (inScope(sc)) clearActionFailure()
      const tab = await getTab(sc.target)
      if (!inScope(sc)) return
      const hostname = hostnameOf(tab?.url)
      if (hostname !== '') {
        await portRef.current?.request('selector.save', { hostname, purpose: 'job_description', selector: picked.selector })
      }
    } catch (e) {
      if (!inScope(sc)) return
      // A relay failure mid-pick is NOT a cancel: say so.
      setScanStatus({ kind: 'action_failed', reason: `Pick failed: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      if (tabIdRef.current === sc.target) setPicking(false)
    }
  }

  const onPickResume = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (file === undefined) return
    await saveResume(file)
    // Text BEFORE name: the rendered name is the outside world's signal that
    // extraction settled.
    setCvText(await loadResumeText())
    setResumeName(file.name)
  }

  const onSaveFacts = async (profile: Record<string, string>, bank: Record<string, string>): Promise<void> => {
    const port = portRef.current
    if (port === null) return
    await port.request('profile.set', { values: profile })
    await port.request('answerBank.set', { values: bank })
    // Merge, never replace: the editor omits keys it never loaded.
    setFacts((f) => ({ ...f, ...profile, ...bank }))
    setView('session')
  }

  const onOnboardingUpload = async (file: File): Promise<string | null> => {
    await saveResume(file)
    const text = await loadResumeText()
    setCvText(text)
    setResumeName(file.name)
    return text
  }

  const onOnboardingExtract = async (cv: string): Promise<Record<string, string> | null> => {
    const port = portRef.current
    if (port === null) return null
    const r = await port.request<Record<string, string>>('facts.extract', { cvText: cv })
    if (!r.ok) { setHostError(hostErrorText(r.error)); return null }
    return r.result
  }

  const onOnboardingFinish = async (profile: Record<string, string>, bank: Record<string, string>): Promise<void> => {
    const port = portRef.current
    if (port === null) return
    // A failed write must NOT unlock scanning: nothing was persisted, and a
    // 'complete' verdict here would be a lie the next panel open disproves.
    // Surface the banner and stay in onboarding — Finish is retryable.
    const p = await port.request('profile.set', { values: profile })
    if (!p.ok) { setHostError(hostErrorText(p.error)); return }
    const b = await port.request('answerBank.set', { values: bank })
    if (!b.ok) { setHostError(hostErrorText(b.error)); return }
    setFacts((f) => ({ ...f, ...profile, ...bank }))
    // The gate's one sanctioned exit; the nonce re-fires the (blocked) auto-scan
    // effect exactly once.
    setCompleteness('complete')
    setScanNonce((n) => n + 1)
  }

  /** S5: end the session and delete its row. Un-debounced by construction —
   *  `store.remove` writes through and TOMBSTONES the tab, so a settle still in
   *  flight can never resurrect it. */
  const endSession = async (id: number): Promise<void> => {
    // Same rule as `onTabRemoved` (Task 14, Finding 2): invalidate only the work
    // that would put THIS session's tab on screen. An unconditional bump here
    // cancelled a swap already heading to a different, live tab — Discard or
    // Mark applied clicked during a tab switch stranded the panel on the tab it
    // had just ended.
    if (swapRef.current.target === id) bumpSwap()
    endRuntime(id)
    lastNavRef.current.delete(id)
    await store.remove(id)
    if (tabIdRef.current === id) display(null)
  }

  /** A2: record the application under the session's START url, then DELETE the
   *  session (S5). A failed mark keeps it — marking is retryable (spec, Error
   *  handling). */
  const onMarkApplied = async (): Promise<void> => {
    const port = portRef.current
    const s = sessionRef.current
    // `startUrl` is a ''-sentinel: marking with an empty url would record garbage
    // into applied_jobs. A PARKED session's page is a different site altogether —
    // recording its start url from that screen is exactly the boundary bug S5
    // exists to close.
    if (port === null || s === null || s.startUrl === '' || s.parked || marking) return
    const target = s.tabId
    const startUrl = s.startUrl
    const markCompany = s.company.trim() === '' ? null : s.company.trim()
    // S7 closes Task 5's parked stale-action race (b): `startUrl` was read before
    // the awaits, so a navigation mid-request paired job A's url with job B's
    // title and wrote it to applied_jobs. The generation is captured at dispatch
    // and re-checked at the moment the submit lands — the same rule every other
    // post-await write now follows.
    const gen = runtimeOf(target).gen
    setMarking(true)
    try {
      const tab = await getTab(target)
      // The page this session described is gone: `tab.title` now names a
      // DIFFERENT posting, and pairing it with job A's url is exactly the
      // silent-wrong-data write. Marking stays available for the new page.
      if (genOf(target) !== gen) return
      const title = (tab?.title ?? '').trim()
      const r = await port.request<{ markedAt: string }>('applied.mark', {
        url: startUrl,
        company: markCompany,
        jobTitle: title === '' ? null : title,
      })
      if (!r.ok) { setHostError(hostErrorText(r.error)); return }
      await endSession(target)
      // B8: the session it would have ridden on no longer exists, so the
      // confirmation is panel-global — and it WINS over any applied badge while
      // it is set.
      setMarkedMsg({ markedAt: r.result.markedAt })
    } finally {
      setMarking(false)
    }
  }

  /** S5 names explicit discard as a deletion path of its own. */
  const onDiscard = async (): Promise<void> => {
    const s = sessionRef.current
    if (s === null) return
    await endSession(s.tabId)
  }

  const onSaveAnswers = async (): Promise<void> => {
    const port = portRef.current
    // S7 constraint 5: the SESSION's tabId, not a panel-global. With no session
    // there is nothing to save but the empty payload, so the displayed tab still
    // stands in.
    const owner = sessionRef.current
    const target = owner?.tabId ?? tabIdRef.current
    if (port === null || target === null || saving) return
    // Same rule as onMarkApplied: the payload below is closed over from THIS
    // render, but `url` is re-read from the tab after several awaits — so a
    // navigation mid-save would file step 1's answers under step 2's url. The
    // generation is captured at dispatch and re-checked at the submit.
    const gen = runtimeOf(target).gen
    setSaving(true)
    try {
      // Merge every snapshot source: SW-stamped pushes (state), the storage.session
      // fallback (durable across a beforeunload race), and a fresh on-demand pull
      // (returns {} if the form was already torn down; the pushes covered that).
      // The area now demonstrably holds NON-snapshot rows (jff:session:*), so the
      // honest declared type is `unknown`; mergeStoredSnapshots' own
      // SNAPSHOT_KEY_RE filter is what actually guarantees the shape it reads.
      const stored: Record<string, unknown> = await chrome.storage.session.get(null)
      const epoch = owner?.epoch ?? runtimeOf(target).epoch
      const live: Record<string, string> = {
        ...snapshot,
        // Tab- and epoch-filtered in save.ts, where the rejection rules are tested.
        ...mergeStoredSnapshots(stored as Record<string, StoredSnapshot>, target, epoch),
      }
      for (const r of (await sendToTab(target, undefined, { type: 'JFF_SNAPSHOT', epoch })).replies) {
        const p = r.payload as { ok: boolean; snapshot?: { values: Record<string, string> } }
        if (p?.ok !== true || p.snapshot === undefined) continue
        for (const [fid, v] of Object.entries(p.snapshot.values)) live[`${r.frameId}:${fid}`] = v
      }
      const items = buildSaveItems({ fields, resolutions, panelEdits: edits, snapshot: live, company: companyOrNull })
        .map((it) => ({ ...it, reusability: reuseOverrides[refOf(it.handle)] ?? it.reusability }))
      const tab = await getTab(target)
      // The page these answers came from is gone: `tab.url` now names a DIFFERENT
      // step (or a different posting), and pairing it with them is the
      // silent-wrong-data write. Saving stays available for the new page.
      if (genOf(target) !== gen) return
      const r = await port.request<{ saved: number }>('save', {
        url: tab?.url ?? '',
        company: companyOrNull,
        items,
        generatedCount: generatedRefs.length,
      })
      setSaveMsg(r.ok ? `Saved ${r.result.saved} answer(s).` : hostErrorText(r.error))
    } catch (e) {
      setSaveMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const loadApplications = async (): Promise<AppliedJobRow[] | null> => {
    const port = portRef.current
    if (port === null) return null
    const r = await port.request<{ jobs: AppliedJobRow[] }>('applied.list', {})
    if (!r.ok) { setHostError(hostErrorText(r.error)); return null }
    // `?? []`: a fake/stale host answering {} must render the empty state,
    // never crash the view on `jobs.map`.
    return r.result.jobs ?? []
  }

  /* ---------------------------------------------------------------- markup */

  const saveItems = buildSaveItems({ fields, resolutions, panelEdits: edits, snapshot, company: companyOrNull })
  const discardButton = (
    <button type="button" className={BTN} data-jff-discard="1" onClick={() => { void onDiscard() }}>
      Discard session
    </button>
  )

  return (
    // The counters are debug surface, not decoration: `data-jff-scans` is how a
    // browser smoke tells a re-scan apart from a redraw, and `data-jff-session`
    // names the session on screen (or 'none' for the empty state).
    <main
      className="p-3" data-jff-ready="1" data-jff-scans={String(scanNonce)} data-jff-view={view}
      data-jff-session={session === null ? 'none' : String(session.tabId)}
    >
      <header className="flex items-center justify-between border-b border-neutral-200 pb-2 dark:border-neutral-700">
        <h1 className="m-0 text-[13px] font-semibold tracking-wide" data-jff-title="1">job-form-filler</h1>
        <span className="text-neutral-500 tabular-nums dark:text-neutral-400" data-jff-tab={String(tabId ?? '')}>
          {tabId === null ? 'no tab' : `tab ${tabId}`}
        </span>
      </header>

      <SelfCheckBanner check={check} error={hostError} />
      {storageWarning && (
        <div className={`${BANNER_BASE} ${BANNER_BAD}`} role="status" data-jff-storage-warn="1">
          Session storage is full — recent changes may not survive closing the panel.
        </div>
      )}

      {completeness === 'incomplete'
        ? (
            <OnboardingView
              key={factsLoaded ? 'loaded' : 'pending'}
              values={facts} loaded={factsLoaded} resumeName={resumeName}
              onUpload={onOnboardingUpload} onExtract={onOnboardingExtract} onFinish={onOnboardingFinish}
            />
          )
        : (
            <>
      {session?.activeCaptcha === true && (
        <div className={`${BANNER_BASE} ${BANNER_BAD}`} role="status" data-jff-captcha="1">
          A CAPTCHA challenge is active on this page. Solve it yourself; the extension will not touch it.
        </div>
      )}
      {(session?.unreachable ?? 0) > 0 && (
        <p className={`mt-3 ${MUTED}`}>{session!.unreachable} widget(s) use closed shadow roots and cannot be read. Fill those by hand.</p>
      )}

      <div className="my-2.5 flex items-center gap-2" data-jff-actions="1">
        {/* onScan takes an explicit target now — never hand it a click event. */}
        <button type="button" className={BTN_PRIMARY} disabled={tabId === null || scanning || parked || !scanGateOpen} onClick={() => { void onScan() }}>
          {busyLabel(scanning, 'Scan', 'Scanning…')}
        </button>
        <button type="button" className={BTN} onClick={() => setView((v) => (v === 'editor' ? 'session' : 'editor'))}>
          {view === 'editor' ? 'Back to fields' : 'Edit your facts'}
        </button>
        <button type="button" className={BTN} data-jff-nav-apps="1" onClick={() => setView((v) => (v === 'applications' ? 'session' : 'applications'))}>
          {view === 'applications' ? 'Back to fields' : 'Applications'}
        </button>
        <button
          type="button" className={BTN} data-jff-mark-applied="1"
          disabled={session === null || session.startUrl === '' || parked || marking}
          onClick={() => { void onMarkApplied() }}
        >
          {busyLabel(marking, 'Mark applied', 'Marking…')}
        </button>
      </div>

      <ScanStatus status={scanStatus} reports={session?.frameReports ?? []} />
      {/* At most ONE data-jff-applied node ever renders: the transient post-mark
          confirmation WINS while it is set, and onScan clears it on entry. */}
      {markedMsg !== null
        ? (
            <div className={BANNER_BASE} role="status" data-jff-applied="1">
              Marked as applied on {new Date(markedMsg.markedAt).toLocaleDateString()}.
            </div>
          )
        : session?.appliedHit != null && (
            <div className={BANNER_BASE} role="status" data-jff-applied="1">
              Already applied on {new Date(session.appliedHit.markedAt).toLocaleDateString()}.
              <button
                type="button" className={`${BTN} ml-2`}
                onClick={() => {
                  runtimeOf(session.tabId).appliedOverride = true
                  writeSession((s) => ({ ...s, appliedHit: null }))
                  setScanNonce((n) => n + 1)
                }}
              >
                Scan anyway
              </button>
            </div>
          )}
      {submitPrompt && (
        <div className={BANNER_BASE} role="status" data-jff-submit-prompt="1">
          Looks like this application was submitted. Mark as applied?
          <span className="ml-2 inline-flex gap-2">
            {/* data hooks: the actions row already owns a 'Mark applied'
                accessible name (A2); tests target these, not roles. */}
            <button type="button" className={BTN} data-jff-prompt-mark="1" onClick={() => { setSubmitPrompt(false); void onMarkApplied() }}>Mark applied</button>
            <button
              type="button" className={BTN} data-jff-prompt-dismiss="1"
              onClick={() => {
                setSubmitPrompt(false)
                if (session !== null) { const rt = runtimeOf(session.tabId); rt.promptDismissedGen = rt.gen }
              }}
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

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
          // Company and job text are SESSION data — with no session there is
          // nowhere for them to live (and nothing to attach them to).
          disabled={session === null}
          // Typing makes the value the USER's: it survives every later re-scan.
          onChange={(e) => { const v = e.target.value; writeSession((s) => ({ ...s, company: v, companyGuessed: false })) }}
          placeholder="Guessed on scan; edit if wrong"
        />
      </label>

      <label className={`my-2.5 block ${MUTED}`} data-jff-paste="1">
        Job description (paste here if the scan could not find it)
        <textarea
          className={`${INPUT} mt-1 resize-y`} rows={4} value={jobText} disabled={session === null}
          onChange={(e) => { const v = e.target.value; writeSession((s) => ({ ...s, jobText: v })) }}
        />
        <button type="button" className={`${BTN} mt-1`} disabled={fields.length === 0 || picking} onClick={onPickJobText}>
          {busyLabel(picking, 'Pick job description', 'Picking… (click the description on the page)')}
        </button>
      </label>

      {view === 'editor'
        ? (
            // `key` remounts the editor the instant the facts arrive, so an editor
            // opened during the load is never stuck on an empty snapshot.
            <ProfileEditor key={factsLoaded ? 'loaded' : 'pending'} values={facts} loaded={factsLoaded} onSave={onSaveFacts} onExtract={onExtractFacts} />
          )
        : view === 'applications'
          ? <ApplicationsView load={loadApplications} />
          : (
            <>
              {session === null
                ? (
                    <p className={`mt-4 ${MUTED}`} data-jff-empty-session="1">
                      No application session on this tab yet. Click Scan to start.
                    </p>
                  )
                : parked
                  ? (
                      <div className="mt-4" data-jff-parked="1">
                        <p className={MUTED}>
                          Session parked — return to {session.site} to continue. Scanning is paused on this page.
                        </p>
                        <div className="mt-2">{discardButton}</div>
                      </div>
                    )
                  : (
                    <>
              {main.length > 0 && (
                <section className="mt-4" data-jff-rows="1">
                  {(generateEligible.length > 0 || generateAll !== null) && (
                    <div className="mb-2" data-jff-generate-all="1">
                      <button
                        type="button" className={BTN}
                        disabled={generateAll !== null || acting !== null}
                        onClick={onGenerateAll}
                      >
                        {generateAll === null
                          ? `Generate all remaining (${generateEligible.length})`
                          : `Generating ${generateAll.done + 1}/${generateAll.total}…`}
                      </button>
                      {generatePaused !== null && generateAll === null && (
                        <p className="mt-1.5 text-neutral-500 dark:text-neutral-400" data-jff-generate-paused="1">
                          Stopped at {generatePaused.done} of {generatePaused.total} — the batch runs
                          only while this tab is on screen. Press the button to carry on.
                        </p>
                      )}
                    </div>
                  )}
                  <ul className="m-0 grid list-none gap-2 p-0">
                    {main.map((row) => (
                      <FieldRow
                        key={row.ref} row={row} edited={edits[row.ref] ?? null}
                        onEdit={onEdit} onAccept={onAccept} onGenerate={onGenerate} onFill={onFill}
                        generating={generatingRefs.has(row.ref)}
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
                    onChange={(e) => {
                      const key = refOf(it.handle)
                      const value = e.target.checked ? 'company_specific' as const : 'reusable' as const
                      writeSession((s) => ({ ...s, reuseOverrides: { ...s.reuseOverrides, [key]: value } }))
                    }}
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
        {session !== null && !parked && discardButton}
        {saveMsg !== null && <span className={MUTED} data-jff-savemsg="1">{saveMsg}</span>}
      </div>
            </>
          )}
            </>
          )}
    </main>
  )
}
