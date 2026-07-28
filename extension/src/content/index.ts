import { ContentMessageSchema, FillReportSchema, ScanResultSchema, STALE_EPOCH } from '@jff/shared'
import { hasActiveCaptcha, isDemographic } from './classify'
import { elementByFid, enumerateFields, getEpoch } from './enumerate'
import { fillFields, fillFile } from './fill'
import { captureJobText, PICK_TIMEOUT_MS, startPicker } from './jobpost'
import { installSnapshotListeners, snapshotValues } from './snapshot'
import { waitForSettle } from './settle'

declare global {
  interface Window { __jffLoaded?: boolean }
}

/**
 * Cheap liveness probe. Permanent: every browser smoke asserts through it, because
 * a content script that silently fails to inject is the classic MV3 failure and no
 * static check can see it.
 */
export function probeFrame(): { controlCount: number; url: string } {
  return {
    controlCount: document.querySelectorAll('input, select, textarea').length,
    url: location.href,
  }
}

async function handle(raw: unknown): Promise<unknown> {
  const parsed = ContentMessageSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'bad_message' }
  const msg = parsed.data

  if (msg.type === 'JFF_PROBE') return { ok: true, probe: probeFrame() }

  // A SCAN establishes the epoch for this frame. Everything else must match it.
  if (msg.type === 'JFF_SCAN') {
    const { fields, unreachableWidgets } = enumerateFields({
      root: document,
      epoch: msg.epoch,
      isDemographic: (el) => isDemographic(el),
    })
    // Validate our OWN reply. This is the consumer ScanResultSchema was written for
    // (Task 2): enumerator drift that emits a malformed field would otherwise reach
    // the host's `resolve` call and fail there as an opaque bad_request, with no way
    // to tell which frame produced it.
    const scan = ScanResultSchema.safeParse({
      epoch: msg.epoch, fields, unreachableWidgets, activeCaptcha: hasActiveCaptcha(document),
    })
    if (!scan.success) return { ok: false, error: 'bad_scan' }
    installSnapshotListeners(document, (snap) => {
      // Fire-and-forget: beforeunload cannot await. The SW stamps sender.tab.id
      // and sender.frameId (this script can know neither), persists the snapshot
      // under a per-tab-per-frame storage.session key, and re-broadcasts it.
      try { void chrome.runtime.sendMessage({ kind: 'fromContent', type: 'JFF_SNAPSHOT_PUSH', snap }) } catch { /* frame tearing down */ }
    })
    return { ok: true, scan: scan.data }
  }

  // Every other message must match the epoch this frame was last scanned at.
  if (msg.epoch !== getEpoch()) return { ok: false, error: STALE_EPOCH }

  if (msg.type === 'JFF_FILL_RESUME') {
    const el = elementByFid(document, msg.handle.fid)
    if (el === null) return { ok: false, error: 'element-not-found' }
    const bytes = Uint8Array.from(atob(msg.dataBase64), (c) => c.charCodeAt(0))
    const file = new File([bytes], msg.fileName, { type: msg.mimeType })
    const out = fillFile(el, file)
    if (!out.ok) return { ok: false, error: out.reason }
    // Let the ATS's async resume auto-parse finish BEFORE anything else is filled.
    await waitForSettle(document)
    return { ok: true }
  }

  if (msg.type === 'JFF_JOBTEXT') {
    return { ok: true, jobText: captureJobText(document, msg.selector) }
  }

  if (msg.type === 'JFF_PICK') {
    // ALWAYS settles: on click, on Escape (pick_cancelled), or at PICK_TIMEOUT_MS.
    // A pending promise here would hold the runtime message channel open for the
    // life of the frame, and the panel's `await sendToTab(...)` with it.
    return await new Promise((resolve) => {
      let stop: (() => void) | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      let done = false
      const settle = (pick: { selector: string; text: string } | null): void => {
        if (done) return
        done = true
        if (timer !== null) clearTimeout(timer)
        if (stop !== null) stop() // idempotent: startPicker already stopped on click/Escape
        resolve(pick === null ? { ok: false, error: 'pick_cancelled' } : { ok: true, pick })
      }
      stop = startPicker(document, settle)
      timer = setTimeout(() => settle(null), PICK_TIMEOUT_MS)
    })
  }

  if (msg.type === 'JFF_SNAPSHOT') {
    return { ok: true, snapshot: { epoch: msg.epoch, values: snapshotValues(document) } }
  }

  if (msg.type === 'JFF_FILL') {
    const report = FillReportSchema.safeParse({ epoch: msg.epoch, ...(await fillFields(document, msg.fills)) })
    // Same reasoning as the scan branch: a malformed report is caught here, in the
    // frame that produced it, not three hops later in the panel.
    if (!report.success) return { ok: false, error: 'bad_fill_report' }
    return { ok: true, fill: report.data }
  }

  return { ok: false, error: 'not_implemented' }
}

// executeScript re-runs this file on every Scan; register listeners exactly once.
if (!window.__jffLoaded) {
  window.__jffLoaded = true
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    handle(raw).then(sendResponse).catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
    return true // keep the message channel open for the async reply
  })
}
