import { atsModule, CapturedPageSchema, ContentMessageSchema, FillReportSchema, findAts, ScanResultSchema, STALE_EPOCH } from '@jff/shared'
import { collectAddresses } from './addresses'
import { capturePage } from './capture'
import { hasActiveCaptcha, isDemographic } from './classify'
import { enumeratedControls, enumerateFields, getEpoch } from './enumerate'
import { fillFields, fillResume } from './fill'
import { PICK_TIMEOUT_MS, postingReaderFor, readJobText, startPicker } from './jobpost'
import { installSnapshotListeners, snapshotValues } from './snapshot'

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

/**
 * #49: whether this document kept a Resume this page script uploaded. It lives
 * as long as the document: a re-injection runs this file again, but only the
 * first run's listener answers, so its copy is the one read. A reload makes a
 * new document and a new first run.
 */
let resumeUploaded = false

async function handle(raw: unknown): Promise<unknown> {
  const parsed = ContentMessageSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'bad_message' }
  const msg = parsed.data

  if (msg.type === 'JFF_PROBE') return { ok: true, probe: probeFrame() }

  // A SCAN establishes the epoch for this frame. Everything else must match it.
  if (msg.type === 'JFF_SCAN') {
    const { fields, unreachableWidgets, attachedUploads } = enumerateFields({
      root: document,
      epoch: msg.epoch,
      isDemographic: (el) => isDemographic(el),
      // Each frame finds its own ATS from its own hostname (spec #41): an
      // embedded Lever form in a company's page is Lever's, the page is not.
      atsModule: atsModule(findAts(location.hostname)?.id),
    })
    // Validate our OWN reply. This is the consumer ScanResultSchema was written for
    // (Task 2): enumerator drift that emits a malformed field would otherwise reach
    // the host's Resolution requests and fail there as an opaque bad_request, with no way
    // to tell which frame produced it.
    const scan = ScanResultSchema.safeParse({
      epoch: msg.epoch, fields, unreachableWidgets, activeCaptcha: hasActiveCaptcha(document), attachedUploads,
      resumeUploaded,
      // Spec #66: the page's addresses, read in the same pass, from the DOM alone.
      addresses: collectAddresses(document),
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
    const bytes = Uint8Array.from(atob(msg.dataBase64), (c) => c.charCodeAt(0))
    const file = new File([bytes], msg.fileName, { type: msg.mimeType })
    // Waits for a young page, attaches, settles, and checks the page kept it.
    const out = await fillResume(document, msg.handle.fid, file)
    // A file the page refused is not remembered: the next Scan tries again.
    if (out.ok) resumeUploaded = true
    return out.ok ? { ok: true } : { ok: false, error: out.reason }
  }

  if (msg.type === 'JFF_JOBTEXT') {
    // The Side panel asks the top frame. On a form page whose module names a
    // Job posting page, the text comes from there (spec #41): fetched on this
    // frame's origin only, without cookies, given up after 5 seconds.
    const jobText = await readJobText(document, msg.selector, postingReaderFor(location.href, (url, init) => fetch(url, init)), enumeratedControls())
    return { ok: true, jobText }
  }

  if (msg.type === 'JFF_CAPTURE') {
    // Only the cleaned copy leaves the tab, and the live page is not touched.
    const capture = CapturedPageSchema.safeParse(capturePage(document, msg.held))
    return capture.success ? { ok: true, capture: capture.data } : { ok: false, error: 'bad_capture' }
  }

  if (msg.type === 'JFF_PAGETEXT') {
    return { ok: true, pageText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000) }
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
