import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureRefusal, type CaptureSaveParams } from '@jff/shared'
import { parseDenylist, redactPrivate, scanLine, type Finding } from '@jff/shared/privateStrings'

/**
 * Saving a Capture (spec #41). The Native host is the door: it refuses a
 * Capture that carries a Value, replaces the user's private strings, real
 * e-mail addresses and credential-shaped strings as the fixture command does,
 * then runs the private-strings check and refuses what it still finds. An
 * accepted Capture is one file, readable by the owner only, in a folder
 * readable by the owner only. Nothing here sends it anywhere.
 */

export interface CapturePlaces {
  /** The captures folder under the app directory, or a test's own. */
  capturesDir: string
  /** The private-strings file; absent means nothing of the user's to replace. */
  privateStringsPath: string
}

export type CaptureOutcome = { ok: true; path: string } | { ok: false; reason: string }

/** The private-strings file's entries; none when there is no file. */
function denylistAt(path: string): string[] {
  return existsSync(path) ? parseDenylist(readFileSync(path, 'utf8')) : []
}

/** Every string inside `value`, at any depth. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

/** `value` with every string inside it replaced as the fixture command replaces. */
function redacted<T>(value: T, denylist: readonly string[]): T {
  return JSON.parse(JSON.stringify(value, (_, v: unknown) => (typeof v === 'string' ? redactPrivate(v, denylist) : v))) as T
}

/** What the check still finds, by rule and count: a finding's own text is never echoed. */
function findingsSummary(findings: readonly Finding[]): string {
  const counts = new Map<string, number>()
  for (const { rule } of findings) counts.set(rule, (counts.get(rule) ?? 0) + 1)
  return [...counts].map(([rule, n]) => `${n} ${rule}`).join(', ')
}

/** A file name that sorts by time and never collides. */
function fileName(now: Date, ats: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const safeAts = ats.replace(/[^a-z0-9-]/gi, '') || 'generic'
  return `${stamp}-${safeAts}-${randomUUID().slice(0, 8)}.json`
}

export function saveCapture(params: CaptureSaveParams, places: CapturePlaces, now: Date = new Date()): CaptureOutcome {
  const refusal = captureRefusal(params)
  if (refusal !== null) return { ok: false, reason: `Capture refused: ${refusal} Nothing was saved.` }

  let denylist: string[]
  try {
    denylist = denylistAt(places.privateStringsPath)
  } catch (e) {
    return { ok: false, reason: `Capture refused: the private-strings file could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was saved.` }
  }

  const { page, ...decided } = params
  const capture = redacted({ capture: 1, savedAt: now.toISOString(), ...decided, page }, denylist)
  const left = stringsIn(capture).flatMap((text) => text.split('\n').flatMap((line) => scanLine(line, denylist)))
  if (left.length > 0) {
    return { ok: false, reason: `Capture refused: after cleaning it still holds ${findingsSummary(left)}. Nothing was saved.` }
  }

  mkdirSync(places.capturesDir, { recursive: true, mode: 0o700 })
  chmodSync(places.capturesDir, 0o700)
  const path = join(places.capturesDir, fileName(now, params.ats))
  writeFileSync(path, `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
  return { ok: true, path }
}
