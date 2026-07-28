import { ContentMessageSchema, STALE_EPOCH } from '@jff/shared'
import { enumerateFields, getEpoch } from './enumerate'

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

function handle(raw: unknown): unknown {
  const parsed = ContentMessageSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'bad_message' }
  const msg = parsed.data

  if (msg.type === 'JFF_PROBE') return { ok: true, probe: probeFrame() }

  // A SCAN establishes the epoch for this frame. Everything else must match it.
  if (msg.type === 'JFF_SCAN') {
    const { fields, unreachableWidgets } = enumerateFields({ root: document, epoch: msg.epoch })
    return { ok: true, scan: { epoch: msg.epoch, fields, unreachableWidgets, activeCaptcha: false } }
  }

  if (msg.epoch !== getEpoch()) return { ok: false, error: STALE_EPOCH }
  return { ok: false, error: 'not_implemented' }
}

// executeScript re-runs this file on every Scan; register listeners exactly once.
if (!window.__jffLoaded) {
  window.__jffLoaded = true
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    sendResponse(handle(raw))
    return false
  })
}
