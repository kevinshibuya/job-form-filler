import type { ContentMessage, EnumField, HostErrorKind, Resolution, ResolveResult } from '@jff/shared'
import type { HostPort } from './port'
import type { StoredResume } from './resume'

export interface FrameReply {
  frameId: number
  payload: unknown
}

export interface ScanDeps {
  tabId: number
  /** Monotonic epoch source. The PANEL owns it; content scripts only store it. */
  nextEpoch: () => number
  inject: () => Promise<number[]>
  sendToTab: (frameId: number | undefined, message: ContentMessage) => Promise<FrameReply[]>
  port: HostPort
  getResume: () => Promise<StoredResume | null>
  pastedJobText: string
  hostname?: string
  url?: string
  company?: string | null
}

export interface ScanOutcome {
  epoch: number
  fields: EnumField[]
  resolutions: Resolution[]
  unreachableWidgets: number
  activeCaptcha: boolean
  jobText: string
  llmError: { kind: HostErrorKind; message: string } | null
}

interface ScanPayload {
  ok: boolean
  scan?: { epoch: number; fields: EnumField[]; unreachableWidgets: number; activeCaptcha: boolean }
}

/** Broadcast a SCAN and stamp each field with the frame its reply came from. */
async function enumerateAllFrames(deps: ScanDeps, epoch: number): Promise<{ fields: EnumField[]; unreachableWidgets: number; activeCaptcha: boolean }> {
  const replies = await deps.sendToTab(undefined, { type: 'JFF_SCAN', epoch })
  const fields: EnumField[] = []
  let unreachableWidgets = 0
  let activeCaptcha = false
  for (const r of replies) {
    const p = r.payload as ScanPayload
    if (p?.ok !== true || p.scan === undefined) continue
    unreachableWidgets += p.scan.unreachableWidgets
    activeCaptcha = activeCaptcha || p.scan.activeCaptcha
    // The content script cannot know its own frame id, so the panel stamps it here.
    for (const f of p.scan.fields) fields.push({ ...f, frameId: r.frameId, epoch })
  }
  return { fields, unreachableWidgets, activeCaptcha }
}

export async function runScan(deps: ScanDeps): Promise<ScanOutcome> {
  await deps.inject()

  // PHASE 0 — first enumeration.
  let epoch = deps.nextEpoch()
  let { fields, unreachableWidgets, activeCaptcha } = await enumerateAllFrames(deps, epoch)

  // Job text: the user's paste always wins; otherwise learned selector, then heuristics.
  let jobText = deps.pastedJobText.trim()
  if (jobText === '') {
    const hostname = deps.hostname ?? ''
    const learned = await deps.port.request<{ selector: string | null }>('selector.get', { hostname, purpose: 'job_description' })
    const selector = learned.ok ? learned.result.selector : null
    const replies = await deps.sendToTab(0, { type: 'JFF_JOBTEXT', epoch, selector })
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
    return { epoch, fields, resolutions: [], unreachableWidgets, activeCaptcha, jobText, llmError: null }
  }

  // PHASE 1 — resume first, then RE-ENUMERATE so the ATS auto-parse cannot clobber us.
  const resume = await deps.getResume()
  const fileField = fields.find((f) => f.kind === 'file')
  if (resume !== null && fileField !== undefined) {
    await deps.sendToTab(fileField.frameId, {
      type: 'JFF_FILL_RESUME', epoch,
      handle: { frameId: fileField.frameId, fid: fileField.fid, epoch },
      fileName: resume.name, mimeType: resume.mimeType, dataBase64: resume.dataBase64,
    })
    epoch = deps.nextEpoch()
    const again = await enumerateAllFrames(deps, epoch)
    fields = again.fields
    unreachableWidgets = again.unreachableWidgets
    activeCaptcha = again.activeCaptcha

    if (activeCaptcha) {
      // Uploading a resume is a common trigger for an ATS challenge. Re-reading
      // activeCaptcha and then filling anyway would be worse than never re-reading
      // it: same blast radius, plus a paid resolve call.
      return { epoch, fields, resolutions: [], unreachableWidgets, activeCaptcha, jobText, llmError: null }
    }
  }

  // PHASE 2 — the host resolves everything that is still open.
  const resolved = await deps.port.request<ResolveResult>('resolve', {
    epoch,
    url: deps.url ?? '',
    hostname: deps.hostname ?? '',
    company: deps.company ?? null,
    jobText,
    fields,
  })
  if (!resolved.ok) {
    return {
      epoch, fields, resolutions: [], unreachableWidgets, activeCaptcha, jobText,
      llmError: resolved.error,
    }
  }

  // Auto-fill tier-1/tier-2 results only. `page` sourced values are already there.
  const byFrame = new Map<number, { handle: Resolution['handle']; value: string }[]>()
  for (const r of resolved.result.resolutions) {
    if (r.tier !== 'auto' || r.source === 'page' || r.value === null || r.value === '') continue
    const list = byFrame.get(r.handle.frameId) ?? []
    list.push({ handle: r.handle, value: r.value })
    byFrame.set(r.handle.frameId, list)
  }
  for (const [frameId, fills] of byFrame) {
    await deps.sendToTab(frameId, { type: 'JFF_FILL', epoch, fills })
  }

  return {
    epoch, fields,
    resolutions: resolved.result.resolutions,
    unreachableWidgets, activeCaptcha, jobText,
    llmError: resolved.result.llmError,
  }
}
