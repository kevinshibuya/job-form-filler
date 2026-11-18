/* eslint-disable no-restricted-properties -- a test-only child process, never a
   Native host: its stdout is a line protocol with the test, not frames. */
// Run by host/src/db/migrations.test.ts through vite-node, two at a time on one
// database file. Says "ready" once openDb is loaded, opens the file on "go"
// with the shipped migrations plus one that adds a column (so it fails if it
// runs twice) and holds the write lock for a second, then exits 0, or 1 with
// the error. Excluded from the host's build.
import { MIGRATIONS, type Migration } from '../db/migrations.js'
import { openDb } from '../db/repos.js'

const path = process.env.JFF_RACE_DB
if (path === undefined) throw new Error('JFF_RACE_DB is not set')

const addProbeColumn: Migration = {
  version: MIGRATIONS.length + 1,
  name: 'test: add a column and hold the lock, which fails the second time',
  up: (db) => {
    db.exec('ALTER TABLE profile ADD COLUMN probe TEXT')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
  },
}

process.stdin.once('data', () => {
  try {
    openDb(path, [...MIGRATIONS, addProbeColumn]).close()
    process.exit(0)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
})
process.stdout.write('ready\n')
