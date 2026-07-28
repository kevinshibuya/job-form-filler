import type { EnumField, Resolution, SaveItem } from '@jff/shared'
import { SNAPSHOT_KEY_RE } from '../snapshotKey'
import { refOf } from './group'

export interface StoredSnapshot {
  epoch: number
  values: Record<string, string>
}

/**
 * The storage.session fallback merge (durable across a beforeunload race), with
 * both rejection rules in one testable place:
 *  - a row from ANOTHER tab is not ours;
 *  - a row from another EPOCH belongs to a previous scan, quite possibly a previous
 *    application on this same tab. Its fids mean nothing to the current scan, so
 *    merging it would attribute old answers to new fields and poison qa_memory.
 */
export function mergeStoredSnapshots(
  stored: Record<string, StoredSnapshot>,
  tabId: number,
  epoch: number,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, snap] of Object.entries(stored)) {
    const m = SNAPSHOT_KEY_RE.exec(key)
    if (m === null || Number(m[1]) !== tabId || snap?.epoch !== epoch) continue
    for (const [fid, v] of Object.entries(snap.values)) out[`${m[2]}:${fid}`] = v
  }
  return out
}

export interface SaveInput {
  fields: EnumField[]
  resolutions: Resolution[]
  /** Typed in the side panel, keyed by "frameId:fid". */
  panelEdits: Record<string, string>
  /** Captured from the live page at submit/unload, keyed by "frameId:fid". */
  snapshot: Record<string, string>
  company: string | null
}

const WHY_HERE =
  /\bwhy (do you want to|would you like to|are you interested in)?\s*(work|join|apply)?\b.*\b(here|us|this (company|team|role))\b|\bpor que\b.*\b(aqui|nossa empresa|conosco|nosso time)\b/i

/**
 * The company-specificity guard starts at save time. The panel shows this as a
 * suggestion and the user confirms; a company_specific answer never auto-fills or
 * proposes verbatim later, it only seeds a [Generate] draft.
 */
export function suggestReusability(questionRaw: string, company: string | null): 'reusable' | 'company_specific' {
  const q = questionRaw.toLowerCase()
  if (WHY_HERE.test(questionRaw)) return 'company_specific'
  if (company !== null && company.trim() !== '' && q.includes(company.trim().toLowerCase())) return 'company_specific'
  return 'reusable'
}

export function buildSaveItems(input: SaveInput): SaveItem[] {
  const byRef = new Map(input.resolutions.map((r) => [refOf(r.handle), r]))
  const items: SaveItem[] = []

  for (const field of input.fields) {
    const ref = refOf(field)
    const resolution = byRef.get(ref)
    if (resolution === undefined) continue
    if (field.demographic || resolution.tier === 'skipped') continue
    if (resolution.source === 'page') continue

    const question = (field.label ?? '').trim()
    if (question === '') continue

    // snapshot > panel edit > engine value
    const final = (input.snapshot[ref] ?? input.panelEdits[ref] ?? resolution.value ?? '').trim()
    if (final === '') continue

    const engine = (resolution.value ?? '').trim()
    if (engine !== '' && engine === final) continue // nothing new was learned

    items.push({
      handle: resolution.handle,
      questionRaw: question,
      answer: final,
      reusability: suggestReusability(question, input.company),
      fieldKey: resolution.key,
    })
  }

  return items
}
