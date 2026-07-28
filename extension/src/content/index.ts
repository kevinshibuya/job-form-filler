import { ContentMessageSchema, FillReportSchema, ScanResultSchema, STALE_EPOCH } from '@jff/shared'
import { hasActiveCaptcha, isDemographic } from './classify'
import { enumerateFields, getEpoch } from './enumerate'
import { fillFields } from './fill'

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
    return { ok: true, scan: scan.data }
  }

  // Every other message must match the epoch this frame was last scanned at.
  if (msg.epoch !== getEpoch()) return { ok: false, error: STALE_EPOCH }

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
