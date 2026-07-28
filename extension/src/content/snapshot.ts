import { walkElements } from './dom'
import { getEpoch } from './enumerate'

export interface SnapshotPayload {
  epoch: number
  values: Record<number, string>
}

function liveValue(el: Element): string {
  if (el instanceof HTMLSelectElement) return (el.selectedOptions[0]?.textContent ?? '').trim()
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked ? 'true' : ''
  if (el instanceof HTMLInputElement && el.type === 'radio') return el.checked ? (el.value || 'true') : ''
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value
  return (el.textContent ?? '').trim()
}

/** Every stamped field's current value, keyed by fid. Empty values are omitted. */
export function snapshotValues(root: Document): Record<number, string> {
  const out: Record<number, string> = {}
  for (const el of walkElements(root)) {
    const raw = el.getAttribute('data-jff-fid')
    if (raw === null) continue
    const fid = Number(raw)
    if (!Number.isInteger(fid)) continue
    const v = liveValue(el)
    if (v.trim() !== '') out[fid] = v
  }
  return out
}

let installed = false

/**
 * CAPTURE-phase listeners: a page handler that calls stopPropagation() in the
 * bubble phase must not be able to suppress the snapshot. beforeunload gives no
 * time for an async round trip, so `push` must be synchronous and fire-and-forget.
 */
export function installSnapshotListeners(root: Document, push: (snap: SnapshotPayload) => void): () => void {
  if (installed) return () => undefined
  installed = true

  const fire = (): void => { push({ epoch: getEpoch(), values: snapshotValues(root) }) }
  root.addEventListener('submit', fire, true)
  window.addEventListener('beforeunload', fire, true)

  return () => {
    root.removeEventListener('submit', fire, true)
    window.removeEventListener('beforeunload', fire, true)
    installed = false
  }
}
