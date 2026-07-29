import type { ContentMessage, EnumField, HostErrorKind, Resolution, ResolveResult } from '@jff/shared'
import { electFrame } from './election'
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

export interface ScanDeps {
  tabId: number
  /** Monotonic epoch source. The PANEL owns it; content scripts only store it. */
  nextEpoch: () => number
  /** THROWS on relay failure — a page we cannot reach is an error, not an empty scan. */
  inject: () => Promise<number[]>
  /** THROWS on relay failure, same contract as inject. */
  sendToTab: (frameId: number | undefined, message: ContentMessage) => Promise<SendResult>
  onProgress: (p: ScanProgress) => void
  sleep: (ms: number) => Promise<void>
  port: HostPort
  getResume: () => Promise<StoredResume | null>
  pastedJobText: string
  hostname?: string
  url?: string
  company?: string | null
}

/** A7's verdict, flattened for the panel: WHICH frame is the application, how
 *  strong the signal was, and where it lives (so a mis-election is explainable). */
export interface ElectionOutcome { frameId: number; score: number; url: string | null }

export interface ScanOutcome {
  epoch: number
  fields: EnumField[]
  resolutions: Resolution[]
  /** null when nothing was elected: no fields survived, or none were seen yet. */
  election: ElectionOutcome | null
  unreachableWidgets: number
  activeCaptcha: boolean
  jobText: string
  llmError: { kind: HostErrorKind; message: string } | null
  frameReports: FrameReport[]
}

interface ScanPayload {
  ok: boolean
  error?: string
  scan?: { epoch: number; fields: EnumField[]; unreachableWidgets: number; activeCaptcha: boolean }
}

interface Enumeration {
  fields: EnumField[]
  unreachableWidgets: number
  activeCaptcha: boolean
  reports: FrameReport[]
}

/** Broadcast a SCAN and stamp each field with the frame its reply came from. */
async function enumerateAllFrames(deps: ScanDeps, epoch: number): Promise<Enumeration> {
  const { replies, failures } = await deps.sendToTab(undefined, { type: 'JFF_SCAN', epoch })
  const reports: FrameReport[] = failures.map((f) => ({ frameId: f.frameId, url: f.url, fields: null, error: f.error }))
  const fields: EnumField[] = []
  let unreachableWidgets = 0
  let activeCaptcha = false
  for (const r of replies) {
    const p = r.payload as ScanPayload
    if (p?.ok !== true || p.scan === undefined) {
      // A malformed or refused reply is diagnostic evidence, not noise.
      reports.push({ frameId: r.frameId, url: r.url ?? null, fields: null, error: p?.error ?? 'unrecognized reply' })
      continue
    }
    unreachableWidgets += p.scan.unreachableWidgets
    activeCaptcha = activeCaptcha || p.scan.activeCaptcha
    // The content script cannot know its own frame id, so the panel stamps it here.
    for (const f of p.scan.fields) fields.push({ ...f, frameId: r.frameId, epoch })
    reports.push({ frameId: r.frameId, url: r.url ?? null, fields: p.scan.fields.length, error: null })
  }
  return { fields, unreachableWidgets, activeCaptcha, reports }
}

async function injectAndEnumerate(deps: ScanDeps): Promise<{ epoch: number; frameCount: number; enumd: Enumeration }> {
  deps.onProgress({ phase: 'injecting' })
  const frames = await deps.inject()
  const epoch = deps.nextEpoch()
  deps.onProgress({ phase: 'enumerating', frames: frames.length })
  return { epoch, frameCount: frames.length, enumd: await enumerateAllFrames(deps, epoch) }
}

export async function runScan(deps: ScanDeps): Promise<ScanOutcome> {
  // PHASE 0 — first enumeration, with ONE delayed retry on an all-empty result.
  let { epoch, frameCount, enumd } = await injectAndEnumerate(deps)
  if (enumd.fields.length === 0) {
    if (enumd.activeCaptcha) {
      // NO retry under an observed challenge. The challenge frame churns during
      // the delay, so a second pass can find fields with the flag back to false —
      // and the scan would then fill past a challenge we already saw.
      return {
        epoch, fields: [], resolutions: [], election: null,
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
        epoch, fields: [], resolutions: [], election: null,
        unreachableWidgets: enumd.unreachableWidgets, activeCaptcha: enumd.activeCaptcha,
        jobText: deps.pastedJobText.trim(), llmError: null, frameReports: enumd.reports,
      }
    }
  }
  let { fields, unreachableWidgets, activeCaptcha, reports } = enumd
  // A5: the content script enumerated and stamped EVERYTHING (snapshot + fid
  // numbering unchanged); the panel drops junk before anything costs money or
  // touches the page. Raw counts above (retry/empty checks) stay raw on purpose.
  let kept = dropJunk(fields)

  // A7: election happens immediately after enumeration/junk-filtering, BEFORE
  // jobText, resume, harvest and resolve — everything page-touching or paid is
  // scoped to the elected frame. Scored over KEPT fields: junk (the hidden
  // reCAPTCHA textarea) must not be able to tilt the election.
  let election = electFrame(kept)
  const electedOf = (fs: EnumField[]): EnumField[] =>
    election === null ? fs : fs.filter((f) => f.frameId === election!.frameId)
  const electionOut = (): ElectionOutcome | null =>
    election === null ? null : {
      frameId: election.frameId,
      score: election.score,
      url: reports.find((r) => r.frameId === election!.frameId && r.url !== null)?.url ?? null,
    }

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
      return { epoch, fields: kept, resolutions: [], election: electionOut(), unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
    }

    // PHASE 1 — resume first, then RE-ENUMERATE so the ATS auto-parse cannot clobber us.
    const resume = await deps.getResume()
    // A8: never `find(kind === 'file')` — score the ELECTED frame's candidates;
    // zero positive scorers means NO upload (the autofill-pane trap).
    const fileField = pickResumeTarget(electedOf(kept))
    if (resume !== null && fileField !== null) {
      let resumeError: FrameReport | null = null
      try {
        await deps.sendToTab(fileField.frameId, {
          type: 'JFF_FILL_RESUME', epoch,
          handle: { frameId: fileField.frameId, fid: fileField.fid, epoch },
          fileName: resume.name, mimeType: resume.mimeType, dataBase64: resume.dataBase64,
        })
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
      reports = resumeError === null ? again.reports : [...again.reports, resumeError]
      // Fids were re-stamped under a new epoch; re-elect deterministically over
      // the fresh kept set. The application frame only gains signal from its
      // own resume-parse, so a flip means the form itself changed.
      election = electFrame(kept)

      if (activeCaptcha) {
        // Uploading a resume is a common trigger for an ATS challenge. Re-reading
        // activeCaptcha and then filling anyway would be worse than never re-reading
        // it: same blast radius, plus a paid resolve call.
        return { epoch, fields: kept, resolutions: [], election: electionOut(), unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
      }
      if (fields.length === 0) {
        // The form went away under us (the upload navigated the frame). Same rule
        // as PHASE 0: resolve is NEVER called with zero fields.
        return { epoch, fields: kept, resolutions: [], election: electionOut(), unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
      }
    }

    // A6: harvest mounted combobox options — ELECTED frame only, never
    // demographic, and only where enumeration found nothing (mutation
    // containment: open/close, no typing, snapshot-restored value).
    if (election !== null) {
      const harvestFids = electedOf(kept)
        .filter((f) => f.kind === 'combobox' && !f.demographic && f.options.length === 0)
        .map((f) => f.fid)
      if (harvestFids.length > 0) {
        try {
          const { replies } = await deps.sendToTab(election.frameId, { type: 'JFF_HARVEST', epoch, fids: harvestFids })
          const p = replies[0]?.payload as { ok?: boolean; options?: Record<string, string[]> } | undefined
          if (p?.ok === true && p.options !== undefined) {
            const opts = p.options
            const merge = (f: EnumField): EnumField => {
              const found = f.frameId === election!.frameId ? opts[String(f.fid)] : undefined
              return found !== undefined && found.length > 0 ? { ...f, options: found } : f
            }
            // Merged BEFORE resolve: the mapping prompt sees the harvested lists.
            fields = fields.map(merge)
            kept = kept.map(merge)
          }
        } catch (e) {
          // Harvest is best-effort by spec: degrade to options [], never fail
          // the scan. The failure is still evidence.
          reports = [...reports, { frameId: election.frameId, url: null, fields: null, error: `harvest failed: ${String(e)}` }]
        }
      }
    }

    if (kept.length === 0) {
      // Only junk on the page: resolve is NEVER called with zero real fields.
      return { epoch, fields: [], resolutions: [], election: null, unreachableWidgets, activeCaptcha, jobText, llmError: null, frameReports: reports }
    }

    // PHASE 2 — the host pays only for the ELECTED frame. Foreign fields still
    // come back in `fields`; they are review-only, never resolved and never filled.
    const resolveFields = electedOf(kept)
    deps.onProgress({ phase: 'resolving', fields: resolveFields.length })
    const resolved = await deps.port.request<ResolveResult>('resolve', {
      epoch,
      url: deps.url ?? '',
      hostname: deps.hostname ?? '',
      company: deps.company ?? null,
      jobText,
      fields: resolveFields,
    })
    if (!resolved.ok) {
      return {
        epoch, fields: kept, resolutions: [], election: electionOut(), unreachableWidgets, activeCaptcha, jobText,
        llmError: resolved.error, frameReports: reports,
      }
    }

    // INTERIM (plan 3 removes this): choice fills need B1's fillChoice —
    // fillCheckbox("Yes") on the hidden input is exactly the silent-no-op /
    // misfill class the spec kills. Until then, choice rows are review-only.
    const choiceRefs = new Set(kept.filter((f) => f.kind === 'choice').map((f) => `${f.frameId}:${f.fid}`))

    // Auto-fill tier-1/tier-2 results only. `page` sourced values are already there.
    const byFrame = new Map<number, { handle: Resolution['handle']; value: string }[]>()
    for (const r of resolved.result.resolutions) {
      if (r.tier !== 'auto' || r.source === 'page' || r.value === null || r.value === '') continue
      if (choiceRefs.has(`${r.handle.frameId}:${r.handle.fid}`)) continue
      const list = byFrame.get(r.handle.frameId) ?? []
      list.push({ handle: r.handle, value: r.value })
      byFrame.set(r.handle.frameId, list)
    }
    for (const [frameId, fills] of byFrame) {
      try {
        await deps.sendToTab(frameId, { type: 'JFF_FILL', epoch, fills })
      } catch (e) {
        // A frame that vanished mid-fill (wizard advanced, iframe swapped) is
        // evidence, not a reason to throw away the resolved scan.
        reports = [...reports, { frameId, url: null, fields: null, error: `fill failed: ${String(e)}` }]
      }
    }

    return {
      epoch, fields: kept,
      resolutions: resolved.result.resolutions,
      election: electionOut(),
      unreachableWidgets, activeCaptcha, jobText,
      llmError: resolved.result.llmError,
      frameReports: reports,
    }
  } catch (e) {
    if (e instanceof ScanError) throw e
    throw new ScanError(e instanceof Error ? e.message : String(e), reports)
  }
}
