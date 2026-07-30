import DatabaseCtor from 'better-sqlite3'
import type { LaunchedExtension } from './ext'

/**
 * O3 era: the panel refuses to scan until a profile is COMPLETE — email, phone,
 * a name, AND a stored resume (see `extension/src/panel/completeness.ts`). Every
 * pre-onboarding e2e mounted the panel against an empty host home and now lands
 * on the onboarding wall instead of the scan UI. These two helpers put the suite
 * back on the far side of that gate:
 *
 *  - `seedOnboardedProfile` writes the host-side half (the `profile` table of the
 *    home the spec's own `startHost` created) — for specs bridged to a REAL host;
 *  - `seedResume` writes the extension-side half (IndexedDB `jff`/`resume`, the
 *    store the panel itself reads) — needed by EVERY spec that mounts the panel,
 *    including the seam-fake-host ones, because Task 3 made the canned persona's
 *    facts complete but a resume can only ever live in the extension origin.
 *
 * Specs whose host is a SCRIPTED `__jffHostBridge` (election, sessions) answer
 * `profile.get` themselves — `ONBOARDED_PROFILE` is exported so they seed the
 * same persona the DB helper does.
 */

/** The minimum `profileCompleteness` accepts, as one shared persona. */
export const ONBOARDED_PROFILE: Readonly<Record<string, string>> = {
  email: 'kevin@example.com',
  phone: '+1 555 0100',
  fullName: 'Kevin Shibuya',
}

/**
 * Direct writes into the host home's `profile` table, bypassing the port — the
 * panel is the thing under test and must not be asked to store its own
 * precondition.
 *
 * `CREATE TABLE IF NOT EXISTS` mirrors `host/src/db/schema.ts` verbatim so this
 * cannot race the host's own startup migration: `startHost` returns as soon as
 * the child is spawned, and whichever of the two connections opens the file
 * first, the other finds the table it needs. `busy_timeout` covers the (idle,
 * but not impossible) case of the host holding a write lock.
 */
export function seedOnboardedProfile(dbPath: string, extra: Record<string, string> = {}): void {
  const db = new DatabaseCtor(dbPath)
  try {
    db.pragma('busy_timeout = 5000')
    db.exec('CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const stmt = db.prepare(
      'INSERT INTO profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    for (const [k, v] of Object.entries({ ...ONBOARDED_PROFILE, ...extra })) stmt.run(k, v)
  } finally {
    db.close()
  }
}

/** The shape `extension/src/panel/resume.ts` persists under key `current`. */
export interface SeededResume {
  name: string
  mimeType: string
  dataBase64: string
  text: string | null
}

export const STUB_RESUME: SeededResume = {
  name: 'cv.txt',
  mimeType: 'text/plain',
  dataBase64: Buffer.from('stub cv', 'utf8').toString('base64'),
  text: 'stub cv',
}

/**
 * Write the stored resume the completeness gate demands, from an
 * EXTENSION-ORIGIN page so IndexedDB lands in the same origin the panel reads
 * (`chrome-extension://<id>`). manifest.json is used for the same reason the
 * `tabIdForUrl` helpers use it: it is an extension resource, so it gets the full
 * origin without MOUNTING the panel app — a second panel would bind to the
 * active tab and auto-scan it, racing whatever the spec is driving.
 */
export async function seedResume(ext: LaunchedExtension, record: SeededResume = STUB_RESUME): Promise<void> {
  const page = await ext.context.newPage()
  try {
    await page.goto(`chrome-extension://${ext.extensionId}/manifest.json`)
    await page.evaluate((rec: SeededResume) => new Promise<void>((resolve, reject) => {
      // Same DB name / version / store / key as resume.ts. The upgrade handler
      // is required: this page may be the first ever to open the database.
      const open = indexedDB.open('jff', 1)
      open.onupgradeneeded = () => { open.result.createObjectStore('resume') }
      open.onerror = () => reject(new Error('indexedDB.open failed'))
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('resume', 'readwrite')
        tx.objectStore('resume').put(rec, 'current')
        tx.onerror = () => reject(new Error('resume put failed'))
        tx.oncomplete = () => { db.close(); resolve() }
      }
    }), record)
  } finally {
    await page.close()
  }
}
