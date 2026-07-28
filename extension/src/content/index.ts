import { ContentMessageSchema } from '@jff/shared'

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
  switch (parsed.data.type) {
    case 'JFF_PROBE':
      return { ok: true, probe: probeFrame() }
    default:
      // Later tasks add SCAN / FILL / SNAPSHOT / PICK / JOBTEXT here.
      return { ok: false, error: 'not_implemented' }
  }
}

// executeScript re-runs this file on every Scan; register listeners exactly once.
if (!window.__jffLoaded) {
  window.__jffLoaded = true
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    sendResponse(handle(raw))
    return false
  })
}
