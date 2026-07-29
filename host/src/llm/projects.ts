import { readFileSync } from 'node:fs'

const PER_FILE_CAP = 4_000
const TOTAL_CAP = 12_000

/** B2c: local project notes for the generation prompt. Missing/unreadable
 *  paths are skipped silently — the config points at living documents, and a
 *  moved file must never break generation. */
export function readProjectNotes(paths: string[]): string | null {
  const parts: string[] = []
  let total = 0
  for (const p of paths) {
    if (total >= TOTAL_CAP) break
    let raw: string
    try { raw = readFileSync(p, 'utf8') } catch { continue }
    const clipped = raw.slice(0, Math.min(PER_FILE_CAP, TOTAL_CAP - total))
    if (clipped.trim() === '') continue
    total += clipped.length
    parts.push(`--- ${p} ---\n${clipped}`)
  }
  return parts.length === 0 ? null : parts.join('\n')
}
