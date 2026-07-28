import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const LOG_PATH = join(homedir(), '.job-form-filler', 'host.log')

let ready = false
function ensureDir(): void {
  if (ready) return
  try { mkdirSync(dirname(LOG_PATH), { recursive: true }) } catch { /* best effort */ }
  ready = true
}

/**
 * NEVER writes to stdout. stdout carries native-messaging frames only; a single
 * stray byte corrupts the channel irrecoverably.
 */
export function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}${extra === undefined ? '' : ' ' + safe(extra)}\n`
  try { process.stderr.write(line) } catch { /* stderr may be closed by Chrome */ }
  try { ensureDir(); appendFileSync(LOG_PATH, line) } catch { /* best effort */ }
}

function safe(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

export const HOST_LOG_PATH = LOG_PATH
