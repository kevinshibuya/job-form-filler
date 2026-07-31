import { normalizeQuestion, type EnumField, type FieldKey, type Resolution } from '@jff/shared'
import { SESSION_KEY_RE, sessionKey } from '../sessionKey'
import { refOf } from './group'
import type { ElectionOutcome, FrameReport } from './scan'
import type { ScanUiState } from './ScanStatus'
import { registrableDomain } from './site'

export const SESSION_VERSION = 1
export const MAX_PERSISTED_OPTIONS = 100
export const SESSION_SAVE_DEBOUNCE_MS = 500

export type AnswerProvenance = 'user' | 'generated'
export interface SessionAnswer { value: string; provenance: AnswerProvenance; fieldKey: FieldKey | null }

export interface Session {
  version: 1
  tabId: number
  /** registrableDomain(startUrl); '' until the first settled scan. */
  site: string
  /** The FIRST scanned page — applied.mark's url (A2). '' until captured. */
  startUrl: string
  parked: boolean
  createdAt: number
  /** Per-session epoch counter (S7). Clock-seeded like App's old epochRef. */
  epoch: number
  fields: EnumField[]
  resolutions: Resolution[]
  edits: Record<string, string>
  /** S4: normalizeQuestion(label) → answer. The ref-INDEPENDENT carry. */
  answers: Record<string, SessionAnswer>
  company: string
  companyGuessed: boolean
  jobText: string
  snapshot: Record<string, string>
  reuseOverrides: Record<string, 'reusable' | 'company_specific'>
  filledRefs: string[]
  generatedRefs: string[]
  unreachable: number
  activeCaptcha: boolean
  election: ElectionOutcome | null
  frameReports: FrameReport[]
  lastOutcome: ScanUiState | null
  appliedHit: { markedAt: string } | null
}

/** S4: answers are keyed by the NORMALIZED label, so a carry survives a field
 *  ref changing across a re-scan. */
export const answerKey = (label: string): string => normalizeQuestion(label)

/**
 * THE stamp source for a session's `createdAt` and for the tombstone times that
 * are compared against it. Clock-seeded, but STRICTLY INCREASING: `Date.now()`
 * alone hands two events in the same millisecond the same number, and the
 * tombstone edge (below) is a `createdAt` vs `removedAt` comparison — a tie
 * there either buries a legitimately new session forever or resurrects a removed
 * one. Every stamp being distinct makes the comparison exact in both directions:
 * created-before-the-removal is always `<`, created-after is always `>`.
 */
let lastStamp = 0
const nextStamp = (): number => {
  const now = Date.now()
  lastStamp = now > lastStamp ? now : lastStamp + 1
  return lastStamp
}

/** The default `startUrl` is the LAZILY-created case (a tab with no scan yet:
 *  `site` stays '' until the first settled scan captures both). */
export function newSession(tabId: number, startUrl = ''): Session {
  // Clock-seeded for the reason App's old epochRef was: a fresh session must
  // never collide with in-flight replies stamped by a previous one.
  const now = nextStamp()
  return {
    version: SESSION_VERSION,
    tabId,
    site: registrableDomain(startUrl),
    startUrl,
    parked: false,
    createdAt: now,
    epoch: now,
    fields: [],
    resolutions: [],
    edits: {},
    answers: {},
    company: '',
    companyGuessed: false,
    jobText: '',
    snapshot: {},
    reuseOverrides: {},
    filledRefs: [],
    generatedRefs: [],
    unreachable: 0,
    activeCaptcha: false,
    election: null,
    frameReports: [],
    lastOutcome: null,
    appliedHit: null,
  }
}

/**
 * S4, one page's field list → (ref → the `answers` key that ref may use).
 *
 * NEVER-GUESS, and it runs in BOTH directions (writes and projection): a key
 * claimed by two or more fields of the SAME page is absent from the map
 * entirely. The carry cannot tell the twins apart, so attributing a value to
 * either of them — here or on the next page — is a silent-wrong-data write.
 * Fields whose label is empty (or normalizes to nothing) never enter, the same
 * rule `save.ts` applies: no key, no carry.
 */
export function answerKeysByRef(fields: EnumField[]): Map<string, string> {
  const claims = new Map<string, string[]>()
  for (const f of fields) {
    const key = answerKey(f.label ?? '')
    if (key === '') continue
    const refs = claims.get(key)
    if (refs === undefined) claims.set(key, [refOf(f)])
    else refs.push(refOf(f))
  }
  const out = new Map<string, string>()
  for (const [key, refs] of claims) if (refs.length === 1) out.set(refs[0]!, key)
  return out
}

/**
 * S4 write path: record what ONE ref now answers under its LABEL key, so the
 * answer outlives the ref. Pure, and a no-op for a field that may not own a key
 * (unlabelled, or a label this page duplicates).
 *
 * An EMPTY value DELETES the entry: a box the user cleared is not an answer, and
 * a stale entry left behind would re-seed the value on the next step.
 */
export function rememberAnswer(
  s: Session,
  ref: string,
  value: string,
  provenance: AnswerProvenance,
): Session {
  const key = answerKeysByRef(s.fields).get(ref)
  if (key === undefined) return s
  if (value === '') {
    if (!(key in s.answers)) return s
    const answers = { ...s.answers }
    delete answers[key]
    return { ...s, answers }
  }
  const fieldKey = s.resolutions.find((r) => refOf(r.handle) === ref)?.key ?? null
  return { ...s, answers: { ...s.answers, [key]: { value, provenance, fieldKey } } }
}

/**
 * S4 projection: THE one place a re-scanned session is rebuilt. App's displayed
 * scan settle and Task 16's background `store.mutate` both call this — a second
 * implementation would be a second copy of the never-guess rules to keep in sync.
 *
 * Refs are meaningless across a re-enumeration (`fid` restarts at 0), so every
 * ref-keyed assertion dies with the page: `filledRefs`, `generatedRefs`,
 * `snapshot`, `reuseOverrides`, `election` and the old `edits`. What comes back
 * is derived from the label-keyed carry:
 *  - primary hit: `answers[answerKey(label)]`;
 *  - secondary hit (primary missed and the new resolution has a key): the SINGLE
 *    answer whose `fieldKey` matches — two or more candidates rescue NOTHING;
 *  - no hit: nothing is attached at all.
 * `committedEdits` — what the batch fill actually put on the page (B1c: its
 * canonical text where the page rewrote the value, else the value that was sent
 * and accepted verbatim) — is AUTHORITATIVE for EVERY ref the fill touched, not
 * merely the ones it canonicalized: the row must keep speaking the page's
 * language, so the projection only seeds refs absent from it.
 *
 * The caller layers the rest of its scan outcome (election, counts, reports) on
 * top of the returned row.
 */
export function projectAnswers(
  session: Session,
  newFields: EnumField[],
  newResolutions: Resolution[],
  committedEdits: Record<string, string>,
): Session {
  const keyOfRef = answerKeysByRef(newFields)
  const fieldKeyOfRef = new Map(newResolutions.map((r) => [refOf(r.handle), r.key]))
  // fieldKey → the SINGLE answer claiming it, or null once contested. The same
  // never-guess rule from the MAP's side: two candidates rescue nothing.
  const byFieldKey = new Map<FieldKey, string | null>()
  for (const [key, a] of Object.entries(session.answers)) {
    if (a.fieldKey === null) continue
    byFieldKey.set(a.fieldKey, byFieldKey.has(a.fieldKey) ? null : key)
  }

  const edits: Record<string, string> = { ...committedEdits }
  const generatedRefs: string[] = []
  for (const f of newFields) {
    const ref = refOf(f)
    // The batch fill already spoke for this ref, in the page's own words.
    if (ref in committedEdits) continue
    const key = keyOfRef.get(ref)
    // No usable label, or one this page duplicates: the carry may attach nothing
    // here at all — the fieldKey fallback included, since two twins matching one
    // answer is the same wrong write from the other end.
    if (key === undefined) continue
    let hit = session.answers[key]
    if (hit === undefined) {
      const fieldKey = fieldKeyOfRef.get(ref) ?? null
      const single = fieldKey === null ? undefined : byFieldKey.get(fieldKey)
      if (single != null) hit = session.answers[single]
    }
    if (hit === undefined || hit.value === '') continue
    edits[ref] = hit.value
    // The draft badge survives the wizard step; nothing else ref-keyed does.
    if (hit.provenance === 'generated') generatedRefs.push(ref)
  }

  return {
    ...session,
    fields: newFields,
    resolutions: newResolutions,
    edits,
    generatedRefs,
    filledRefs: [],
    snapshot: {},
    reuseOverrides: {},
    election: null,
  }
}

/** Storage-shaping only — never mutates the in-memory session, whose full option
 *  lists the open combobox still needs. */
export function capForStorage(s: Session): Session {
  return {
    ...s,
    fields: s.fields.map((f) =>
      f.options.length > MAX_PERSISTED_OPTIONS
        ? { ...f, options: f.options.slice(0, MAX_PERSISTED_OPTIONS) }
        : f),
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Structural gate on untrusted storage rows: a version mismatch or any shape
 *  surprise yields null rather than a half-typed Session. Never throws. */
export function parseStoredSession(raw: unknown): Session | null {
  try {
    if (!isRecord(raw)) return null
    if (raw.version !== SESSION_VERSION) return null
    if (typeof raw.tabId !== 'number' || !Number.isFinite(raw.tabId)) return null
    if (typeof raw.createdAt !== 'number' || typeof raw.epoch !== 'number') return null
    if (typeof raw.site !== 'string' || typeof raw.startUrl !== 'string') return null
    if (typeof raw.company !== 'string' || typeof raw.jobText !== 'string') return null
    if (typeof raw.parked !== 'boolean' || typeof raw.companyGuessed !== 'boolean') return null
    if (typeof raw.activeCaptcha !== 'boolean' || typeof raw.unreachable !== 'number') return null
    if (!Array.isArray(raw.fields) || !Array.isArray(raw.resolutions)) return null
    if (!Array.isArray(raw.filledRefs) || !Array.isArray(raw.generatedRefs)) return null
    if (!Array.isArray(raw.frameReports)) return null
    if (!isRecord(raw.edits) || !isRecord(raw.answers)) return null
    if (!isRecord(raw.snapshot) || !isRecord(raw.reuseOverrides)) return null
    return raw as unknown as Session
  } catch {
    return null
  }
}

/** The slice of a storage area this module uses. Structural on purpose: tests
 *  pass a fake, and nothing here reaches for a chrome global beyond the default. */
export interface SessionArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

export interface SessionStore {
  /** Pending-first read-your-writes — and it runs on the STORE LOCK (below),
   *  so a load issued during an in-flight mutate observes the mutated row. */
  load(tabId: number): Promise<Session | null>
  /** Only rows whose key matches SESSION_KEY_RE — the storage area is shared
   *  with jff:snap:* rows, which are not ours to read (or prune). */
  loadAll(): Promise<Session[]>
  /** Debounced latest-wins per tab. Rows pass capForStorage at ENTRY, so the
   *  pending map and storage always agree on shape. A save of a session a
   *  `remove` already buried is silently dropped; a save of a session CREATED
   *  after that removal lifts the tombstone and persists normally (see below). */
  save(session: Session): void
  /**
   * THE way concurrent/settling writers touch a session they do not display
   * (Task 16). ONE link on the store lock: read pending-first, apply fn, drop
   * the tab's pending entry, write through capForStorage — with NO await
   * between the read and the pending-drop. Returns the row actually WRITTEN
   * (a caller that turns out to be displaying this tab re-projects the display
   * from it — the swap-race repair), or null when fn dropped. A mutate against
   * a TOMBSTONED tab resolves null without running fn. Quota failure inside
   * mutate follows the same policy as save: evict-and-retry once, else the
   * merged row parks in pending + onWarn.
   */
  mutate(tabId: number, fn: (s: Session | null) => Session | null): Promise<Session | null>
  /** Fires after EVERY successful storage write (save-flush or mutate), with
   *  the written row. Subscribers are notified AFTER the lock link releases,
   *  are NEVER awaited, and each runs in its own try/catch — a throwing
   *  subscriber cannot reject the chain, and a subscriber that calls back
   *  into the store enqueues a FRESH link (no deadlock; reentrancy test).
   *  Task 16 subscribes: a write for the currently-displayed tabId re-projects
   *  the display. Returns an unsubscribe. */
  onWrite(cb: (tabId: number, s: Session) => void): () => void
  /** Resolves only when every pending row is written AND every already-queued
   *  lock link has settled — a flush cannot outrun an in-flight mutate. */
  flush(): Promise<void>
  /** Drops the tab's PENDING row, deletes the stored row, and TOMBSTONES the
   *  session (the tabId stamped with the removal time) — all on the store lock,
   *  so a remove issued during an in-flight mutate or flush wins (no
   *  resurrection). Also a LIVE-tab path: Mark applied and Discard end a session
   *  on a tab that stays open, which is why the tombstone buries that session
   *  rather than the tab id forever. */
  remove(tabId: number): Promise<void>
  /** Per-key delete on the store lock; deleted tabs are tombstoned and their
   *  pending rows dropped; keys not matching SESSION_KEY_RE are untouched. */
  prune(liveTabIds: ReadonlySet<number>): Promise<void>
}

export interface SessionStoreOpts {
  onWarn?: () => void
  getDisplayedTabId?: () => number | null
}

export function createSessionStore(
  area: SessionArea = chrome.storage.session,
  debounceMs: number = SESSION_SAVE_DEBOUNCE_MS,
  opts: SessionStoreOpts = {},
): SessionStore {
  /** Debounce buffer only — NOT a lock. Rows here are already capForStorage'd. */
  const pending = new Map<number, Session>()
  /** tabId → the `nextStamp()` of the removal that buried it.
   *
   *  A tombstone buries exactly ONE session: the one that was removed. `remove` is
   *  NOT a dead-tab-only path — the panel's lifecycle calls it for Mark applied and
   *  Discard too, on a tab that is still ALIVE — so a session CREATED after the
   *  removal is a different application and must be allowed to persist. A dead tab
   *  can never produce one (nothing creates a session for a tab that is gone), so
   *  the anti-resurrection property is preserved exactly: a stale displayed-state
   *  save landing after the tab closed carries the REMOVED session's `createdAt`
   *  and is still dropped. Both sides come from `nextStamp`, so an existing
   *  session's `createdAt` is ALWAYS strictly below the stamp of a later removal
   *  and a session minted afterwards is ALWAYS strictly above it — which is why
   *  the edge below is `<` and not `<=`: a tie can only be a session the removal
   *  did not precede, and burying it would lose it forever (only `save` lifts a
   *  tombstone, and `save` is exactly what a tie would drop). */
  const tombstones = new Map<number, number>()

  /** Is this exact session buried? (Only `createdAt` can answer — the tabId alone
   *  cannot tell the removed session apart from its successor.) */
  const buried = (s: Session): boolean => {
    const removedAt = tombstones.get(s.tabId)
    return removedAt !== undefined && s.createdAt < removedAt
  }
  /** A genuinely newer session claims the tab back, so later reads (`mutate`)
   *  stop refusing it. Call sites must have cleared `buried` first. */
  const unbury = (s: Session): void => {
    const removedAt = tombstones.get(s.tabId)
    if (removedAt !== undefined && s.createdAt > removedAt) tombstones.delete(s.tabId)
  }
  const subs = new Set<(tabId: number, s: Session) => void>()
  let timer: ReturnType<typeof setTimeout> | null = null

  /** ONE global FIFO storage-operation lock. Every storage-touching operation
   *  enqueues here, so cross-tab eviction and two-tab interleaving vanish as a
   *  CLASS instead of needing per-case lock ordering. */
  let chain: Promise<unknown> = Promise.resolve()
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Rows written inside the current lock link, notified once it releases. */
  let notifyQueue: Session[] = []
  const drainNotify = (): void => {
    if (notifyQueue.length === 0) return
    const batch = notifyQueue
    notifyQueue = []
    for (const row of batch) {
      for (const cb of [...subs]) {
        // Never awaited, individually isolated: a throwing subscriber cannot
        // reject the store's chain.
        try { cb(row.tabId, row) } catch { /* subscriber's problem, not ours */ }
      }
    }
  }

  const clearTimer = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
  }

  const armTimer = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void withLock(flushPending).then(drainNotify, drainNotify)
    }, debounceMs)
  }

  /** Oldest PARKED stored session, excluding the row being written and the
   *  displayed one. Runs INSIDE the caller's lock link (one link, per contract). */
  const evictOne = async (writingTabId: number): Promise<boolean> => {
    const displayed = opts.getDisplayedTabId?.() ?? null
    const all = await area.get(null)
    let victim: Session | null = null
    for (const [key, raw] of Object.entries(all)) {
      if (!SESSION_KEY_RE.test(key)) continue
      const s = parseStoredSession(raw)
      if (s === null || !s.parked) continue
      if (s.tabId === writingTabId || s.tabId === displayed) continue
      if (victim === null || s.createdAt < victim.createdAt) victim = s
    }
    if (victim === null) return false
    await area.remove(sessionKey(victim.tabId))
    return true
  }

  /** Single write attempt + the S6 quota policy. Inside the lock. */
  const writeRow = async (row: Session): Promise<boolean> => {
    try {
      await area.set({ [sessionKey(row.tabId)]: row })
      notifyQueue.push(row)
      return true
    } catch {
      // Eviction is the one data-loss path: never silent.
      if (await evictOne(row.tabId)) {
        opts.onWarn?.()
        try {
          await area.set({ [sessionKey(row.tabId)]: row })
          notifyQueue.push(row)
          return true
        } catch { /* fall through to deferral */ }
      }
      // No candidate (or the retry failed too): defer, never discard.
      if (!pending.has(row.tabId) && !buried(row)) pending.set(row.tabId, row)
      opts.onWarn?.()
      return false
    }
  }

  async function flushPending(): Promise<void> {
    clearTimer()
    for (const row of [...pending.values()]) {
      pending.delete(row.tabId)
      // A `remove` that landed between the save and this flush buries the row.
      if (buried(row)) continue
      await writeRow(row)
    }
  }

  const readRow = async (tabId: number): Promise<Session | null> => {
    const got = await area.get(sessionKey(tabId))
    return parseStoredSession(got[sessionKey(tabId)])
  }

  return {
    load: (tabId) => withLock(async () => {
      const held = pending.get(tabId)
      if (held !== undefined) return held
      return await readRow(tabId)
    }),

    loadAll: () => withLock(async () => {
      const all = await area.get(null)
      const out: Session[] = []
      for (const [key, raw] of Object.entries(all)) {
        if (!SESSION_KEY_RE.test(key)) continue
        const s = parseStoredSession(raw)
        if (s !== null) out.push(s)
      }
      return out
    }),

    save(session) {
      if (buried(session)) return
      // The one place a tombstone is LIFTED: persisting a session created after
      // the removal is what proves the tab came back into use.
      unbury(session)
      pending.set(session.tabId, capForStorage(session))
      armTimer()
    },

    // The tombstone reads below stay keyed on the tabId alone, and that is exact:
    // a session newer than the removal can only reach `pending`/storage through
    // `save`, which LIFTS the tombstone first. So a tombstone still standing here
    // means the only session this tab could hold is the removed one.
    mutate: (tabId, fn) => withLock(async () => {
      if (tombstones.has(tabId)) return null
      let base = pending.get(tabId) ?? null
      if (base === null) {
        const stored = await readRow(tabId)
        // Re-read pending AFTER the await, then drop with no await in between:
        // a save that landed during the get must not be silently discarded.
        base = pending.get(tabId) ?? stored
      }
      // What is about to leave the debounce buffer — re-read for the same reason
      // `base` was, and with no await between the read and the delete.
      const held = pending.get(tabId) ?? null
      pending.delete(tabId)
      if (tombstones.has(tabId)) return null
      const next = fn(base)
      if (next === null) {
        // fn DROPPED the mutation (a non-elected subframe navigation, a stale
        // generation, a rejected snapshotPush) — but the debounced row is already
        // out of `pending`, and nothing below will write it. Put it back, or the
        // user's unsaved edits are silently replaced by the OLDER stored row on
        // the next rehydrate. `armTimer` is a no-op when a timer is already
        // running; it matters when the drop raced the flush that was going to
        // write this row.
        if (held !== null) { pending.set(tabId, held); armTimer() }
        return null
      }
      const capped = capForStorage(next)
      await writeRow(capped)
      return capped
    }).then((r) => { drainNotify(); return r }, (e: unknown) => { drainNotify(); throw e }),

    onWrite(cb) {
      subs.add(cb)
      return () => { subs.delete(cb) }
    },

    flush: () => withLock(flushPending).then(drainNotify, drainNotify),

    remove: (tabId) => withLock(async () => {
      pending.delete(tabId)
      tombstones.set(tabId, nextStamp())
      await area.remove(sessionKey(tabId))
    }),

    prune: (liveTabIds) => withLock(async () => {
      const all = await area.get(null)
      for (const key of Object.keys(all)) {
        const m = SESSION_KEY_RE.exec(key)
        if (m === null) continue
        const tabId = Number(m[1])
        if (liveTabIds.has(tabId)) continue
        pending.delete(tabId)
        tombstones.set(tabId, nextStamp())
        await area.remove(key)
      }
    }),
  }
}
