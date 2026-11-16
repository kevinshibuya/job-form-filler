import {
  atsIdOf, atsModule,
  type AtsModule, type AtsOrGeneric, type CityParts, type ContentMessage, type EnumField, type FieldHandle, type FillReport,
  type HostErrorKind, type PhoneParts, type Resolution, type ResolveFirstResult, type ResolveMappingResult,
} from '@jff/shared'
import { guessScanCompany } from './company'
import { electFrame } from './election'
import { refOf } from './group'
import { dropJunk } from './junk'
import type { HostPort } from './port'
import { pickResumeTarget } from './resumeTarget'
import type { StoredResume } from './resume'

export interface FrameReply {
  frameId: number
  url?: string | null
  payload: unknown
}

export interface RelayFailure { frameId: number; url: string | null; error: string }

export interface SendResult { replies: FrameReply[]; failures: RelayFailure[] }

/** One row of scan diagnostics: what each frame contributed, or why it could not. */
export interface FrameReport { frameId: number; url: string | null; fields: number | null; error: string | null }

/** A scan that died AFTER enumeration still knows what every frame contributed.
 *  Throwing a bare Error would drop that evidence exactly when the user needs it. */
export class ScanError extends Error {
  constructor(message: string, readonly frameReports: FrameReport[]) {
    super(message)
    this.name = 'ScanError'
  }
}

export type ScanProgress =
  | { phase: 'injecting' }
  | { phase: 'enumerating'; frames: number }
  | { phase: 'retrying' }
  | { phase: 'resolving'; fields: number }

/** A page can report zero fields transiently (an iframe mid-navigation is skipped
 *  by executeScript). One delayed re-look absorbs that; more would turn the panel
 *  into a poller. */
export const RETRY_DELAY_MS = 1_500

/**
 * S7: there is deliberately NO `tabId` here. A scan's target lives in the
 * `inject`/`sendToTab` pair the caller BINDS to it — a declared-but-unread
 * tabId invited a second, disagreeing source of truth for where a JFF_FILL
 * lands, and JFF_FILL writes to the page.
 */
export interface ScanDeps {
  /** Monotonic epoch source, per SESSION. The PANEL owns it; content scripts
   *  only store it. */
  nextEpoch: () => number
  /** THROWS on relay failure — a page we cannot reach is an error, not an empty
   *  scan. Bound by the caller to the tab this scan was dispatched for. */
  inject: () => Promise<number[]>
  /** THROWS on relay failure, same contract as inject. Bound to the same tab. */
  sendToTab: (frameId: number | undefined, message: ContentMessage) => Promise<SendResult>
  onProgress: (p: ScanProgress) => void
  sleep: (ms: number) => Promise<void>
  port: HostPort
  getResume: () => Promise<StoredResume | null>
  pastedJobText: string
  hostname?: string
  url?: string
  /** The tab's title, which the Company guess reads. */
  title?: string
  /** The Company the Session already holds, typed or guessed by an earlier
   *  Scan. It is sent as it is and never replaced; only when it is empty does
   *  the Scan guess one. */
  company?: string | null
  /** The ATS module of a Scan's ATS. Defaults to the shared registry; a test
   *  hands the Scan a module with a rule no real module has yet. */
  moduleFor?: (ats: AtsOrGeneric) => AtsModule
}

/** An address's hostname, or '' when it has none (`about:blank`, a srcdoc
 *  frame, an unparseable string). */
function hostOf(url: string | null | undefined): string {
  if (url == null || url === '') return ''
  try { return new URL(url).hostname } catch { return '' }
}

/**
 * The ATS of a Scan (spec #41), from the list's own `findAts`, so the page
 * script and the Side panel cannot disagree. With an elected frame it is that
 * frame's address, or the tab's hostname when the frame has no address. With
 * none, the zero-Field case, it is the first known ATS among the tab's
 * hostname and the frames' addresses, which is what makes an Ashby iframe on a
 * company's page Ashby. A form on the company's own domain with no iframe is
 * generic.
 */
export function scanAts(
  tabHostname: string, elected: { url: string | null } | null, frameUrls: readonly (string | null)[],
): AtsOrGeneric {
  if (elected !== null) {
    const own = hostOf(elected.url)
    return atsIdOf(own !== '' ? own : tabHostname)
  }
  for (const host of [tabHostname, ...frameUrls.map(hostOf)]) {
    const ats = atsIdOf(host)
    if (ats !== 'generic') return ats
  }
  return 'generic'
}

/** A module's junk rule, run after the generic filter on the elected frame's
 *  Fields only: a Field in another frame is never the module's to drop. */
function dropModuleJunk(fields: EnumField[], electedFrameId: number | null, mod: AtsModule): EnumField[] {
  const rule = mod.junkRule
  if (rule === undefined || electedFrameId === null) return fields
  return fields.filter((f) => f.frameId !== electedFrameId || !rule(f))
}

/** A7's verdict, flattened for the panel: WHICH frame is the application, how
 *  strong the signal was, and where it lives (so a mis-election is explainable). */
export interface ElectionOutcome { frameId: number; score: number; url: string | null }

export interface FillFailure { handle: FieldHandle; reason: string; options?: string[] }

/** B3: what the batched scan-time auto-fill ACTUALLY did, per the frames' own
 *  JFF_FILL reports. `filled` is page-accepted only — the count the status
 *  line shows. Failures carry the frame's per-field reason so the panel can
 *  demote the row and render the hint. Either kind carries the Options a
 *  choice Fill read on the page. */
export interface CollectedFill {
  filled: { handle: FieldHandle; committed: string | null; options?: string[] }[]
  failed: FillFailure[]
}

/**
 * The Fields with the Options a Fill read on the page. A Scan opens no menu
 * (ADR 0009), so a dropdown's Options are first known once a Fill has opened
 * it, on a hit or a miss; from then on its row offers them as a picker. A
 * report that read no Options leaves the Field as it was.
 */
export function withReadOptions(
  fields: EnumField[],
  fill: { filled: readonly { handle: FieldHandle; options?: string[] }[]; failed: readonly { handle: FieldHandle; options?: string[] }[] },
): EnumField[] {
  const read = new Map<string, string[]>()
  for (const f of [...fill.filled, ...fill.failed]) {
    if (f.options !== undefined && f.options.length > 0) read.set(refOf(f.handle), f.options)
  }
  if (read.size === 0) return fields
  return fields.map((f) => {
    const options = read.get(refOf(f))
    return options === undefined ? f : { ...f, options }
  })
}

const emptyFill = (): CollectedFill => ({ filled: [], failed: [] })

export interface ScanOutcome {
  epoch: number
  /** The Scan's ATS: what both Resolution requests carry and the Session keeps. */
  ats: AtsOrGeneric
  /** The Company both Resolution requests carry: the one the Session held, or
   *  else the Scan's guess. */
  company: string | null
  /** Whether `company` is the Scan's guess, which the Session marks as one. */
  companyGuessed: boolean
  fields: EnumField[]
  /** The first step's Resolutions: everything that needed no model. */
  resolutions: Resolution[]
  /** The elected Fields the first step left for Mapping. Empty means no second
   *  request is owed. They carry no Resolution until `runMapping` lands. */
  pending: EnumField[]
  fill: CollectedFill
  /** null when nothing was elected: no fields survived, or none were seen yet. */
  election: ElectionOutcome | null
  /** #37: the elected frame's upload groups that show an attached file, by
   *  label. Empty when nothing was elected or the frame reported none. */
  attachedUploads: string[]
  unreachableWidgets: number
  activeCaptcha: boolean
  jobText: string
  llmError: { kind: HostErrorKind; message: string } | null
  frameReports: FrameReport[]
}

interface ScanPayload {
  ok: boolean
  error?: string
  scan?: { epoch: number; fields: EnumField[]; unreachableWidgets: number; activeCaptcha: boolean; attachedUploads?: string[] }
}

interface Enumeration {
  fields: EnumField[]
  unreachableWidgets: number
  activeCaptcha: boolean
  /** frameId -> the labels of that frame's attached uploads (#37). */
  attachedUploads: Map<number, string[]>
  reports: FrameReport[]
}

/** Broadcast a SCAN and stamp each field with the frame its reply came from. */
async function enumerateAllFrames(deps: ScanDeps, epoch: number): Promise<Enumeration> {
  const { replies, failures } = await deps.sendToTab(undefined, { type: 'JFF_SCAN', epoch })
  const reports: FrameReport[] = failures.map((f) => ({ frameId: f.frameId, url: f.url, fields: null, error: f.error }))
  const fields: EnumField[] = []
  let unreachableWidgets = 0
  let activeCaptcha = false
  const attachedUploads = new Map<number, string[]>()
  for (const r of replies) {
    const p = r.payload as ScanPayload
    if (p?.ok !== true || p.scan === undefined) {
      // A malformed or refused reply is diagnostic evidence, not noise.
      reports.push({ frameId: r.frameId, url: r.url ?? null, fields: null, error: p?.error ?? 'unrecognized reply' })
      continue
    }
    unreachableWidgets += p.scan.unreachableWidgets
    activeCaptcha = activeCaptcha || p.scan.activeCaptcha
    // A stale content script omits the list: it reads as none.
    attachedUploads.set(r.frameId, p.scan.attachedUploads ?? [])
    // The content script cannot know its own frame id, so the panel stamps it here.
    for (const f of p.scan.fields) fields.push({ ...f, frameId: r.frameId, epoch })
    reports.push({ frameId: r.frameId, url: r.url ?? null, fields: p.scan.fields.length, error: null })
  }
  return { fields, unreachableWidgets, activeCaptcha, attachedUploads, reports }
}

async function injectAndEnumerate(deps: ScanDeps): Promise<{ epoch: number; frameCount: number; enumd: Enumeration }> {
  deps.onProgress({ phase: 'injecting' })
  const frames = await deps.inject()
  const epoch = deps.nextEpoch()
  deps.onProgress({ phase: 'enumerating', frames: frames.length })
  return { epoch, frameCount: frames.length, enumd: await enumerateAllFrames(deps, epoch) }
}

/** The Session's Company, or null when it holds none. */
const knownCompany = (deps: ScanDeps): string | null => {
  const known = deps.company?.trim() ?? ''
  return known === '' ? null : known
}

/** The Company of a Scan whose ATS and elected frame are known: the
 *  Session's, or else the guess (spec #41). */
function scanCompany(deps: ScanDeps, ats: AtsOrGeneric, frameUrl: string | null): string | null {
  return knownCompany(deps) ?? guessScanCompany({
    ats, title: deps.title ?? '', hostname: deps.hostname ?? '', url: deps.url ?? '', frameUrl,
  })
}

/**
 * Inject, enumerate, elect, upload the Resume, and send the first Resolution
 * request. The Company is guessed once the elected frame is known, before that
 * request, so the request carries it; the outcome carries the same Company,
 * worked out from the same ATS and elected frame.
 */
export async function runScan(deps: ScanDeps): Promise<ScanOutcome> {
  const out = await scanPage(deps)
  const company = scanCompany(deps, out.ats, out.election?.url ?? null)
  return { ...out, company, companyGuessed: company !== null && knownCompany(deps) === null }
}

async function scanPage(deps: ScanDeps): Promise<Omit<ScanOutcome, 'company' | 'companyGuessed'>> {
  const tabHostname = deps.hostname ?? ''
  const moduleFor = deps.moduleFor ?? atsModule
  const noElectionAts = (reports: FrameReport[]): AtsOrGeneric =>
    scanAts(tabHostname, null, reports.map((r) => r.url))
  // PHASE 0 — first enumeration, with ONE delayed retry on an all-empty result.
  let { epoch, frameCount, enumd } = await injectAndEnumerate(deps)
  if (enumd.fields.length === 0) {
    if (enumd.activeCaptcha) {
      // NO retry under an observed challenge. The challenge frame churns during
      // the delay, so a second pass can find fields with the flag back to false —
      // and the scan would then fill past a challenge we already saw.
      return {
        epoch, ats: noElectionAts(enumd.reports), fields: [], resolutions: [], pending: [], fill: emptyFill(), election: null, attachedUploads: [],
        unreachableWidgets: enumd.unreachableWidgets, activeCaptcha: true,
        jobText: deps.pastedJobText.trim(), llmError: null, frameReports: enumd.reports,
      }
    }
    // First-attempt ERRORS are evidence (they may be WHY the page looked empty);
    // they survive the retry. First-attempt field counts are superseded.
    const firstErrors = enumd.reports.filter((r) => r.error !== null)
    deps.onProgress({ phase: 'retrying' })
    await deps.sleep(RETRY_DELAY_MS)
    try {
      ;({ epoch, frameCount, enumd } = await injectAndEnumerate(deps))
    } catch (e) {
      // The retry runs under the SAME evidence contract as everything below: a
      // relay that dies here must not throw away the first pass's per-frame rows,
      // which are frequently the reason the page enumerated empty at all.
      throw new ScanError(e instanceof Error ? e.message : String(e), firstErrors)
    }
    enumd.reports = [...firstErrors, ...enumd.reports]
    if (enumd.fields.length === 0) {
      // An empty page must cost zero host round-trips: no selector.get, no resolve.
      return {
        epoch, ats: noElectionAts(enumd.reports), fields: [], resolutions: [], pending: [], fill: emptyFill(), election: null, attachedUploads: [],
        unreachableWidgets: enumd.unreachableWidgets, activeCaptcha: enumd.activeCaptcha,
        jobText: deps.pastedJobText.trim(), llmError: null, frameReports: enumd.reports,
      }
    }
  }
  let { fields, unreachableWidgets, activeCaptcha, reports } = enumd
  const urlOfFrame = (frameId: number): string | null =>
    reports.find((r) => r.frameId === frameId && r.url !== null)?.url ?? null
  let attachedByFrame = enumd.attachedUploads
  // A5: the content script enumerated and stamped EVERYTHING (snapshot + fid
  // numbering unchanged); the panel drops junk before anything costs money or
  // touches the page. Raw counts above (retry/empty checks) stay raw on purpose.
  let kept = dropJunk(fields)

  // A7: election happens immediately after enumeration/junk-filtering, BEFORE
  // jobText, resume and resolve — everything page-touching or paid is
  // scoped to the elected frame. Scored over KEPT fields: junk (the hidden
  // reCAPTCHA textarea) must not be able to tilt the election.
  let election = electFrame(kept)
  // Spec #41: the elected frame names the Scan's ATS, and that ATS's module
  // drops what it knows to be noise, from the elected frame only.
  const atsOf = (): AtsOrGeneric => election === null
    ? noElectionAts(reports)
    : scanAts(tabHostname, { url: urlOfFrame(election.frameId) }, [])
  let ats = atsOf()
  kept = dropModuleJunk(kept, election?.frameId ?? null, moduleFor(ats))
  const electedOf = (fs: EnumField[]): EnumField[] =>
    election === null ? fs : fs.filter((f) => f.frameId === election!.frameId)
  const electionOut = (): ElectionOutcome | null =>
    election === null ? null : { frameId: election.frameId, score: election.score, url: urlOfFrame(election.frameId) }
  // #37: only the elected frame's attach counts, like its file fields.
  const electedAttached = (): string[] =>
    election === null ? [] : attachedByFrame.get(election.frameId) ?? []

  // Everything past the enumeration runs under ScanError: a jobtext/resolve/fill
  // relay death must reach the panel WITH the per-frame evidence already collected,
  // not as a bare message that erases it.
  try {
    // Job text: the user's paste always wins; otherwise learned selector, then heuristics.
    let jobText = deps.pastedJobText.trim()
    if (jobText === '') {
      const hostname = deps.hostname ?? ''
      const learned = await deps.port.request<{ selector: string | null }>('selector.get', { hostname, purpose: 'job_description' })
      const selector = learned.ok ? learned.result.selector : null
      const { replies } = await deps.sendToTab(0, { type: 'JFF_JOBTEXT', epoch, selector })
      const payload = replies[0]?.payload as { ok: boolean; jobText?: { text: string; selector: string | null; source: string } } | undefined
      if (payload?.ok === true && payload.jobText !== undefined && payload.jobText.source !== 'none') {
        jobText = payload.jobText.text
        if (payload.jobText.source === 'heuristic' && payload.jobText.selector !== null) {
          await deps.port.request('selector.save', { hostname, purpose: 'job_description', selector: payload.jobText.selector })
        }
      }
    }

    if (activeCaptcha) {
      // An active challenge means the extension does nothing at all on this page.
      return { epoch, ats, fields: kept, resolutions: [], pending: [], fill: emptyFill(), election: electionOut(), attachedUploads: electedAttached(), unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
    }

    // PHASE 1 — resume first, then RE-ENUMERATE so the ATS auto-parse cannot clobber us.
    const resume = await deps.getResume()
    // A8: never `find(kind === 'file')` — score the ELECTED frame's candidates;
    // zero positive scorers means NO upload (the autofill-pane trap). A resume
    // the page already shows attached means NO upload either (#37).
    const fileField = pickResumeTarget(electedOf(kept), electedAttached())
    if (resume !== null && fileField !== null) {
      let resumeError: FrameReport | null = null
      try {
        const { replies } = await deps.sendToTab(fileField.frameId, {
          type: 'JFF_FILL_RESUME', epoch,
          handle: { frameId: fileField.frameId, fid: fileField.fid, epoch },
          fileName: resume.name, mimeType: resume.mimeType, dataBase64: resume.dataBase64,
        })
        // A page that refused the file (or a stale frame) is reported, never dropped.
        const reply = replies[0]?.payload as { ok?: boolean; error?: string } | undefined
        if (reply?.ok !== true) {
          resumeError = { frameId: fileField.frameId, url: null, fields: null, error: `resume upload failed: ${reply?.error ?? 'no reply'}` }
        }
      } catch (e) {
        // A dead resume-upload relay must not discard the whole scan: the field
        // list and the paid resolve are still worth having. Report and continue.
        resumeError = { frameId: fileField.frameId, url: null, fields: null, error: `resume upload failed: ${String(e)}` }
      }
      epoch = deps.nextEpoch()
      deps.onProgress({ phase: 'enumerating', frames: frameCount })
      const again = await enumerateAllFrames(deps, epoch)
      fields = again.fields
      kept = dropJunk(fields)
      unreachableWidgets = again.unreachableWidgets
      activeCaptcha = again.activeCaptcha
      attachedByFrame = again.attachedUploads
      reports = resumeError === null ? again.reports : [...again.reports, resumeError]
      // Fids were re-stamped under a new epoch; re-elect deterministically over
      // the fresh kept set. The application frame only gains signal from its
      // own resume-parse, so a flip means the form itself changed.
      election = electFrame(kept)
      // The second read is a new page as far as the module knows: ask again.
      ats = atsOf()
      kept = dropModuleJunk(kept, election?.frameId ?? null, moduleFor(ats))

      if (activeCaptcha) {
        // Uploading a resume is a common trigger for an ATS challenge. Re-reading
        // activeCaptcha and then filling anyway would be worse than never re-reading
        // it: same blast radius, plus a paid resolve call.
        return { epoch, ats, fields: kept, resolutions: [], pending: [], fill: emptyFill(), election: electionOut(), attachedUploads: electedAttached(), unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
      }
      if (fields.length === 0) {
        // The form went away under us (the upload navigated the frame). Same rule
        // as PHASE 0: resolve is NEVER called with zero fields.
        return { epoch, ats, fields: kept, resolutions: [], pending: [], fill: emptyFill(), election: electionOut(), attachedUploads: electedAttached(), unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
      }
    }

    if (kept.length === 0) {
      // Only junk on the page: resolve is NEVER called with zero real fields.
      return { epoch, ats, fields: [], resolutions: [], pending: [], fill: emptyFill(), election: null, attachedUploads: [], unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
    }

    // PHASE 2 — the host is asked about the ELECTED frame only. Foreign fields
    // still come back in `fields`; they are review-only, never resolved and
    // never filled. This is the FIRST step: no model runs, so what the profile
    // and the Saved answers already know reaches the page without waiting on
    // Mapping. The Fields it leaves pending go out in `runMapping`.
    const resolveFields = electedOf(kept)
    if (resolveFields.length === 0) {
      // A module's junk rule took every elected Field: resolve is NEVER called
      // with zero real fields.
      return { epoch, ats, fields: kept, resolutions: [], pending: [], fill: emptyFill(), election: electionOut(), attachedUploads: electedAttached(), unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
    }
    deps.onProgress({ phase: 'resolving', fields: resolveFields.length })
    const resolved = await deps.port.request<ResolveFirstResult>('resolve.first', {
      epoch,
      url: deps.url ?? '',
      hostname: deps.hostname ?? '',
      company: scanCompany(deps, ats, electionOut()?.url ?? null),
      jobText,
      fields: resolveFields,
      ats,
    })
    if (!resolved.ok) {
      return {
        epoch, ats, fields: kept, resolutions: [], pending: [], fill: emptyFill(), election: electionOut(), attachedUploads: electedAttached(), unreachableWidgets, activeCaptcha, jobText,
        llmError: resolved.error, frameReports: reports,
      }
    }

    const pendingRefs = new Set(resolved.result.pending.map(refOf))
    const batch = await fillAuto(deps.sendToTab, epoch, resolved.result.resolutions)
    reports = [...reports, ...batch.reports]

    return {
      epoch, ats, fields: kept,
      resolutions: resolved.result.resolutions,
      pending: resolveFields.filter((f) => pendingRefs.has(refOf(f))),
      fill: batch.fill,
      election: electionOut(),
      attachedUploads: electedAttached(),
      unreachableWidgets, activeCaptcha, jobText,
      llmError: null,
      frameReports: reports,
    }
  } catch (e) {
    if (e instanceof ScanError) throw e
    throw new ScanError(e instanceof Error ? e.message : String(e), reports)
  }
}

/**
 * One entry of a JFF_FILL message: the handle, the value, and the candidate
 * words, phone parts and city parts of the Resolution's Value, which go only
 * with that Value itself. A value the user edited is matched by its own text,
 * so it travels without them.
 */
export function fillEntry(
  resolution: Pick<Resolution, 'handle' | 'value' | 'candidates' | 'phone' | 'city'>, value: string,
): { handle: Resolution['handle']; value: string; candidates?: string[]; phone?: PhoneParts; city?: CityParts } {
  const own = value === resolution.value
  const candidates = own ? resolution.candidates ?? [] : []
  return {
    handle: resolution.handle, value,
    ...(candidates.length === 0 ? {} : { candidates }),
    ...(own && resolution.phone !== undefined ? { phone: resolution.phone } : {}),
    ...(own && resolution.city !== undefined ? { city: resolution.city } : {}),
  }
}

/**
 * A row read by the Fill that follows a Scan (ticket #34): Needs input with no
 * Value, but with a stored Value it is known to ask for. It is sent with no
 * Value, so the page only reports the Control's Options, and the model pick is
 * then asked with that stored Value.
 */
export const isReadRow = (r: Resolution): boolean =>
  r.tier === 'needs_input' && r.value === null && r.identifiedValue !== undefined

/**
 * B3: the batched scan-time Fill. Tier `auto` Resolutions with a value are
 * filled; `page` sourced values are already there. Rows with no Value but an
 * identified stored one are read (isReadRow); every other row is not sent.
 * Each frame's own JFF_FILL report decides what counts as filled.
 */
async function fillAuto(
  sendToTab: ScanDeps['sendToTab'], epoch: number, resolutions: Resolution[],
): Promise<{ fill: CollectedFill; reports: FrameReport[] }> {
  const byFrame = new Map<number, (ReturnType<typeof fillEntry> | { handle: FieldHandle })[]>()
  for (const r of resolutions) {
    const read = isReadRow(r)
    if (!read && (r.tier !== 'auto' || r.source === 'page' || r.value === null || r.value === '')) continue
    const list = byFrame.get(r.handle.frameId) ?? []
    list.push(read ? { handle: r.handle } : fillEntry(r, r.value!))
    byFrame.set(r.handle.frameId, list)
  }
  const fill = emptyFill()
  const reports: FrameReport[] = []
  for (const [frameId, fills] of byFrame) {
    try {
      const { replies } = await sendToTab(frameId, { type: 'JFF_FILL', epoch, fills })
      const p = replies[0]?.payload as { ok?: boolean; error?: string; fill?: FillReport } | undefined
      if (p?.ok === true && p.fill !== undefined) {
        fill.filled.push(...p.fill.filled)
        fill.failed.push(...p.fill.failed)
      } else {
        // A refused envelope (stale_epoch, bad_fill_report) accepted NOTHING:
        // every fill sent to this frame failed, with the frame's own reason.
        for (const f of fills) fill.failed.push({ handle: f.handle, reason: p?.error ?? 'no-fill-report' })
      }
    } catch (e) {
      // A frame that vanished mid-fill (wizard advanced, iframe swapped) is
      // evidence, not a reason to throw away the resolved scan.
      reports.push({ frameId, url: null, fields: null, error: `fill failed: ${String(e)}` })
      for (const f of fills) fill.failed.push({ handle: f.handle, reason: 'frame-unreachable' })
    }
  }
  return { fill, reports }
}

/** The reason a Field Mapping never answered carries: the reply left it out,
 *  or the request was lost with the panel that sent it. */
export const MAPPING_LOST = 'mapping-lost'

/** What `runMapping` needs: the host, the scan's own relay, and the page context. */
export type MappingDeps = Pick<ScanDeps, 'port' | 'sendToTab' | 'hostname' | 'url' | 'company'>

/** The second step's result, merged by the caller onto the first step's rows. */
export interface MappingOutcome {
  /** One per pending Field the host answered, Needs input on a failure. */
  resolutions: Resolution[]
  fill: CollectedFill
  llmError: { kind: HostErrorKind; message: string } | null
  /** Frames a Mapping Fill could not reach. */
  frameReports: FrameReport[]
}

/**
 * The second step: `resolve.mapping` over the Fields the first step left
 * pending, then a Fill of whatever it answers `auto`, under the scan's own
 * epoch. Only pending Fields are sent, so nothing the first step filled is
 * filled again. It never throws: a request that fails outright makes every
 * pending Field Needs input with the error, as a Mapping failure does.
 *
 * `isCurrent` is asked when the reply lands. A reply for a Scan that a newer
 * one superseded is dropped there: null, and no Fill.
 */
export async function runMapping(
  deps: MappingDeps, scan: Pick<ScanOutcome, 'epoch' | 'ats' | 'jobText' | 'pending'>, isCurrent: () => boolean,
): Promise<MappingOutcome | null> {
  const failed = (llmError: { kind: HostErrorKind; message: string }): MappingOutcome => ({
    resolutions: scan.pending.map((f) => ({
      handle: { frameId: f.frameId, fid: f.fid, epoch: f.epoch },
      tier: 'needs_input', value: null, source: null, key: null, answerId: null,
      reason: `llm-error:${llmError.kind}`,
    })),
    fill: emptyFill(), llmError, frameReports: [],
  })
  let resolved
  try {
    resolved = await deps.port.request<ResolveMappingResult>('resolve.mapping', {
      epoch: scan.epoch,
      url: deps.url ?? '',
      hostname: deps.hostname ?? '',
      company: deps.company ?? null,
      jobText: scan.jobText,
      fields: scan.pending,
      ats: scan.ats,
    })
  } catch (e) {
    return isCurrent() ? failed({ kind: 'unreachable', message: e instanceof Error ? e.message : String(e) }) : null
  }
  if (!isCurrent()) return null
  if (!resolved.ok) return failed(resolved.error)

  // The host answers every Field it is sent, but only pending ones may land:
  // a Resolution for anything else would overwrite a first-step row. A pending
  // Field the reply leaves out becomes Needs input, so no row stays waiting.
  const pendingRefs = new Set(scan.pending.map(refOf))
  const resolutions = resolved.result.resolutions.filter((r) => pendingRefs.has(refOf(r.handle)))
  const answered = new Set(resolutions.map((r) => refOf(r.handle)))
  for (const f of scan.pending) {
    if (answered.has(refOf(f))) continue
    resolutions.push({
      handle: { frameId: f.frameId, fid: f.fid, epoch: f.epoch },
      tier: 'needs_input', value: null, source: null, key: null, answerId: null, reason: MAPPING_LOST,
    })
  }
  const batch = await fillAuto(deps.sendToTab, scan.epoch, resolutions)
  return { resolutions, fill: batch.fill, llmError: resolved.result.llmError, frameReports: batch.reports }
}
