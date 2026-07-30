import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnumField } from '@jff/shared'
import { sessionKey } from '../sessionKey'
import {
  answerKey, capForStorage, createSessionStore, MAX_PERSISTED_OPTIONS,
  newSession, parseStoredSession, SESSION_VERSION, type Session,
} from './sessions'

interface Hold { on: boolean; release: () => void }

/** Deferrable fake area: `holdNextGet`/`holdNextSet` park the NEXT get/set on a
 *  promise until `release()` — how the lock tests interleave a second store
 *  call mid-flight. Tests `await drain()` after starting the in-flight op so
 *  the hold is actually armed before releasing. */
function fakeArea(): {
  rows: Record<string, unknown>
  area: Parameters<typeof createSessionStore>[0]
  failNextSet: { on: boolean }
  holdNextGet: Hold
  holdNextSet: Hold
} {
  const rows: Record<string, unknown> = {}
  const failNextSet = { on: false }
  const holdNextGet: Hold = { on: false, release: () => {} }
  const holdNextSet: Hold = { on: false, release: () => {} }
  const gate = async (h: Hold): Promise<void> => {
    if (!h.on) return
    h.on = false
    await new Promise<void>((r) => { h.release = r })
  }
  const area = {
    get: vi.fn(async (q: string | string[] | null) => {
      await gate(holdNextGet)
      if (q === null) return { ...rows }
      const keys = Array.isArray(q) ? q : [q]
      return Object.fromEntries(keys.filter((k) => k in rows).map((k) => [k, rows[k]]))
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      await gate(holdNextSet)
      if (failNextSet.on) { failNextSet.on = false; throw new Error('QUOTA_BYTES quota exceeded') }
      Object.assign(rows, items)
    }),
    remove: vi.fn(async (keys: string | string[]) => { for (const k of [keys].flat()) delete rows[k] }),
  } as unknown as Parameters<typeof createSessionStore>[0]
  return { rows, area, failNextSet, holdNextGet, holdNextSet }
}

/** Spin the microtask queue until an in-flight store call has reached its held
 *  get/set before the test releases it. (Two turns, as first drafted, is one
 *  short: enqueueing on the store lock costs a turn of its own before the
 *  operation body even starts, so a mutate whose held write follows a storage
 *  READ arms on turn 3. Releasing a hold that is not yet armed hits the no-op
 *  `release` and wedges the test, so this over-spins on purpose — a hold that
 *  IS armed never resolves on its own, making extra turns free.) */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const field = (fid: number, options: string[] = []): EnumField => ({
  frameId: 0, fid, epoch: 1, label: `F${fid}`, name: null, idAttr: null, kind: 'combobox',
  options, required: false, visible: true, currentValue: null, demographic: false,
})

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('sessions module (S1/S6)', () => {
  it('save is debounced latest-wins; flush writes NOW', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 500)
    const s = newSession(7, 'https://jobs.acme.com/apply')
    store.save({ ...s, company: 'v1' })
    store.save({ ...s, company: 'v2' })
    expect(rows[sessionKey(7)]).toBeUndefined()
    await vi.advanceTimersByTimeAsync(500)
    expect((rows[sessionKey(7)] as Session).company).toBe('v2')
    store.save({ ...s, company: 'v3' })
    await store.flush()
    expect((rows[sessionKey(7)] as Session).company).toBe('v3')
  })

  it('load round-trips; a version-mismatched row is dropped; corrupt rows never throw', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    const s = newSession(7, 'https://jobs.acme.com/apply')
    store.save(s)
    await store.flush()
    expect(await store.load(7)).toMatchObject({ tabId: 7, site: 'acme.com', version: SESSION_VERSION })
    rows[sessionKey(8)] = { ...s, tabId: 8, version: 99 }
    expect(await store.load(8)).toBeNull()
    rows[sessionKey(9)] = 'garbage'
    expect(await store.load(9)).toBeNull()
    expect((await store.loadAll()).map((x) => x.tabId)).toEqual([7])
  })

  it('remove cancels the pending debounced write', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save(newSession(7, 'https://a.com'))
    await store.remove(7)
    await vi.advanceTimersByTimeAsync(1000)
    expect(rows[sessionKey(7)]).toBeUndefined()
  })

  it('prune drops sessions whose tab is gone', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(1, 'https://a.com')); store.save(newSession(2, 'https://b.com'))
    await store.flush()
    await store.prune(new Set([2]))
    expect(Object.keys(rows)).toEqual([sessionKey(2)])
  })

  it('persisted options are capped at 100 per field; the in-memory session is untouched', () => {
    const big = newSession(7, 'https://a.com')
    big.fields = [field(0, Array.from({ length: 250 }, (_, i) => `o${i}`))]
    const capped = capForStorage(big)
    expect(capped.fields[0]!.options.length).toBe(MAX_PERSISTED_OPTIONS)
    expect(big.fields[0]!.options.length).toBe(250)
  })

  it('the cap applies through save AND mutate — pending and stored rows always agree', async () => {
    // A background scan settle (Task 16) writes via mutate; without capping at
    // BOTH entries, a pending-first load could surface an uncapped row.
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    await store.mutate(7, (s) => (s === null ? null : {
      ...s, fields: [field(0, Array.from({ length: 250 }, (_, i) => `o${i}`))],
    }))
    expect((rows[sessionKey(7)] as Session).fields[0]!.options.length).toBe(MAX_PERSISTED_OPTIONS)
    expect((await store.load(7))!.fields[0]!.options.length).toBe(MAX_PERSISTED_OPTIONS)
  })

  it('quota failure evicts the oldest PARKED session (warning the user) and retries; never the one being written', async () => {
    const { rows, area, failNextSet } = fakeArea()
    const warn = vi.fn()
    const store = createSessionStore(area, 0, { onWarn: warn })
    const oldParked = { ...newSession(1, 'https://old.com'), parked: true, createdAt: 100 }
    const newerParked = { ...newSession(2, 'https://newer.com'), parked: true, createdAt: 200 }
    store.save(oldParked); store.save(newerParked)
    await store.flush()
    failNextSet.on = true
    store.save(newSession(7, 'https://active.com'))
    await store.flush()
    expect(rows[sessionKey(1)]).toBeUndefined()      // oldest parked evicted
    expect(rows[sessionKey(2)]).toBeDefined()
    expect(rows[sessionKey(7)]).toBeDefined()        // the write landed on retry
    expect(warn).toHaveBeenCalled()                  // eviction is data loss: never silent
  })

  it('eviction never targets the DISPLAYED session, even when parked', async () => {
    const { rows, area, failNextSet } = fakeArea()
    const store = createSessionStore(area, 0, { getDisplayedTabId: () => 1 })
    store.save({ ...newSession(1, 'https://old.com'), parked: true, createdAt: 100 })
    store.save({ ...newSession(2, 'https://newer.com'), parked: true, createdAt: 200 })
    await store.flush()
    failNextSet.on = true
    store.save(newSession(7, 'https://active.com'))
    await store.flush()
    expect(rows[sessionKey(1)]).toBeDefined()        // displayed: protected
    expect(rows[sessionKey(2)]).toBeUndefined()      // next-oldest parked evicted instead
    expect(rows[sessionKey(7)]).toBeDefined()
  })

  it('quota failure with NO parked candidate warns, keeps the row PENDING, and the next flush retries it', async () => {
    const { rows, area, failNextSet } = fakeArea()
    const warn = vi.fn()
    const store = createSessionStore(area, 0, { onWarn: warn })
    failNextSet.on = true
    store.save(newSession(7, 'https://active.com'))
    await expect(store.flush()).resolves.toBeUndefined() // never throws
    expect(rows[sessionKey(7)]).toBeUndefined()          // deferred, not stored yet…
    expect(warn).toHaveBeenCalledTimes(1)                // …and VISIBLY so
    await store.flush()                                  // area recovered: retry lands
    expect(rows[sessionKey(7)]).toBeDefined()
  })

  it('load during a pending debounced write sees the pending value (read-your-writes)', async () => {
    const { area } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save({ ...newSession(7, 'https://a.com'), company: 'pending-co' })
    expect((await store.load(7))!.company).toBe('pending-co')
  })

  it('two concurrent mutates for one tab both land (serialized, never last-writer-wins)', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    await Promise.all([
      store.mutate(7, (s) => (s === null ? null : { ...s, filledRefs: [...s.filledRefs, 'a'] })),
      store.mutate(7, (s) => (s === null ? null : { ...s, generatedRefs: [...s.generatedRefs, 'b'] })),
    ])
    const row = rows[sessionKey(7)] as Session
    expect(row.filledRefs).toContain('a')
    expect(row.generatedRefs).toContain('b')
  })

  it('mutate reads the PENDING row, writes through, and supersedes the stale debounce', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save({ ...newSession(7, 'https://a.com'), company: 'from-display' })   // debounced, unflushed
    await store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'from-settle' }))
    const row = rows[sessionKey(7)] as Session
    expect(row.company).toBe('from-display')  // the mutate SAW the pending row
    expect(row.jobText).toBe('from-settle')   // …and wrote through immediately
    await vi.advanceTimersByTimeAsync(1000)   // the old debounce must not clobber it
    expect((rows[sessionKey(7)] as Session).jobText).toBe('from-settle')
  })

  it('mutate on a missing session with fn returning null writes nothing and resolves null (the drop arm)', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    await expect(store.mutate(42, (s) => s)).resolves.toBeNull()  // s === null → null → no write
    expect(rows[sessionKey(42)]).toBeUndefined()
  })

  it('mutate notifies onWrite with the written row (the display re-projection hook)', async () => {
    const { area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    const writes: [number, Session][] = []
    const off = store.onWrite((tabId, s) => writes.push([tabId, s]))
    const written = await store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'x' }))
    expect(written!.jobText).toBe('x')
    expect(writes.some(([t, s]) => t === 7 && s.jobText === 'x')).toBe(true)
    off()
  })

  it('remove during an in-flight mutate wins — the row is never resurrected', async () => {
    const { rows, area, holdNextGet } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    holdNextGet.on = true
    const m = store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'late' }))
    await drain()
    const r = store.remove(7)   // enqueues BEHIND the in-flight mutate on the store lock
    holdNextGet.release()
    await Promise.all([m, r])
    expect(rows[sessionKey(7)]).toBeUndefined()  // the remove ran last: no resurrection
    // …and the tab is TOMBSTONED: even a later mutate that tries to rebuild the
    // session from scratch is refused.
    await expect(store.mutate(7, (s) => s ?? newSession(7))).resolves.toBeNull()
    expect(rows[sessionKey(7)]).toBeUndefined()
  })

  it('save after remove is dropped — a dead tab is never resurrected (tombstone)', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    await store.remove(7)
    store.save(newSession(7, 'https://a.com'))   // a stale displayed-state save after the tab closed
    await store.flush()
    expect(rows[sessionKey(7)]).toBeUndefined()
  })

  it('a tombstone buries the REMOVED session only — a new one on the same LIVE tab persists', async () => {
    // `remove` is not a dead-tab-only path: Task 14's lifecycle table calls it for
    // Mark applied and Discard, on a tab that is still alive. A PERMANENT tombstone
    // made every later application in that tab memory-only (and made `mutate`
    // answer null, which Task 16 would misread as "dropped").
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    // The clock is FROZEN here (fake timers), so every createdAt/removedAt is
    // stated explicitly rather than inferred from wall time.
    const removedAt = Date.now()
    const first: Session = { ...newSession(7, 'https://a.com'), createdAt: removedAt - 1 }
    store.save(first)
    await store.flush()

    await store.remove(7)                     // Mark applied on a tab that is still open
    expect(rows[sessionKey(7)]).toBeUndefined()

    // The removed session itself may never come back…
    store.save({ ...first, company: 'resurrected' })
    await store.flush()
    expect(rows[sessionKey(7)]).toBeUndefined()
    await expect(store.mutate(7, (s) => (s === null ? null : { ...s, company: 'zombie' }))).resolves.toBeNull()

    // …but the NEXT application in that same tab is a different session, and it
    // must persist exactly like any other.
    const second: Session = { ...newSession(7, 'https://b.com'), createdAt: removedAt + 1 }
    store.save(second)
    await store.flush()
    expect((rows[sessionKey(7)] as Session).startUrl).toBe('https://b.com')

    const written = await store.mutate(7, (s) => (s === null ? null : { ...s, company: 'Globex' }))
    expect(written?.company).toBe('Globex')
    expect((rows[sessionKey(7)] as Session).company).toBe('Globex')
  })

  it('flush during an in-flight mutate does not clobber it', async () => {
    const { rows, area, holdNextSet } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save({ ...newSession(7, 'https://a.com'), company: 'old' })   // pending, unflushed
    holdNextSet.on = true
    const m = store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'from-settle' }))
    await drain()
    const f = store.flush()     // must serialize behind the mutate's held write
    holdNextSet.release()
    await Promise.all([m, f])
    const row = rows[sessionKey(7)] as Session
    expect(row.company).toBe('old')             // the pending content the mutate consumed…
    expect(row.jobText).toBe('from-settle')     // …never clobbered back by the flush
  })

  it('load issued during an in-flight mutate observes the mutated row', async () => {
    const { area, holdNextSet } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    holdNextSet.on = true
    const m = store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'mutated' }))
    await drain()
    const l = store.load(7)     // enqueued on the same lock: sees the result
    holdNextSet.release()
    const [, row] = await Promise.all([m, l])
    expect(row!.jobText).toBe('mutated')
  })

  it('the INVERSE interleaving: a mutate arriving during an in-flight flush reads the flushed row and wins', async () => {
    // The mutate-first case above is not enough — a naive implementation that
    // only serializes mutates passes it. Here the stale-looking write is the
    // FLUSH, already in flight when the mutate arrives.
    const { rows, area, holdNextSet } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save({ ...newSession(7, 'https://a.com'), company: 'from-display' })  // pending
    holdNextSet.on = true
    const f = store.flush()     // the save-flush write is now in flight (held)
    await drain()
    const m = store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'from-settle' }))
    holdNextSet.release()
    await Promise.all([f, m])
    const row = rows[sessionKey(7)] as Session
    expect(row.company).toBe('from-display')  // the mutate read the FLUSHED row…
    expect(row.jobText).toBe('from-settle')   // …and the mutate's result is what stands
  })

  it('remove during an in-flight flush wins — the row is deleted, not resurrected', async () => {
    const { rows, area, holdNextSet } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save(newSession(7, 'https://a.com'))
    holdNextSet.on = true
    const f = store.flush()
    await drain()
    const r = store.remove(7)   // queues behind the held write on the store lock
    holdNextSet.release()
    await Promise.all([f, r])
    expect(rows[sessionKey(7)]).toBeUndefined()
  })

  it('one flush lands every pending tab independently', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 500)
    store.save({ ...newSession(1, 'https://a.com'), company: 'one' })
    store.save({ ...newSession(2, 'https://b.com'), company: 'two' })
    await store.flush()
    expect((rows[sessionKey(1)] as Session).company).toBe('one')
    expect((rows[sessionKey(2)] as Session).company).toBe('two')
  })

  it('an onWrite subscriber may call back into the store without deadlock (fresh link)', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    let reentered: Promise<Session | null> | null = null
    const off = store.onWrite((tabId, s) => {
      if (tabId === 7 && s.jobText === 'first' && reentered === null) {
        // Same-tab reentrancy: this enqueues a FRESH lock link — notification
        // happens after the first link released, so this must not deadlock.
        reentered = store.mutate(7, (x) => (x === null ? null : { ...x, company: 'second' }))
      }
    })
    await store.mutate(7, (s) => (s === null ? null : { ...s, jobText: 'first' }))
    await drain()
    await reentered
    expect((rows[sessionKey(7)] as Session).company).toBe('second')
    off()
  })

  it('loadAll and prune ignore foreign jff:snap rows sharing the storage area', async () => {
    const { rows, area } = fakeArea()
    const store = createSessionStore(area, 0)
    rows['jff:snap:7:0'] = { epoch: 1, values: { 0: 'x' } }
    store.save(newSession(7, 'https://a.com'))
    await store.flush()
    expect((await store.loadAll()).map((s) => s.tabId)).toEqual([7])
    await store.prune(new Set<number>())
    expect(rows['jff:snap:7:0']).toBeDefined()   // snapshot rows are not ours to prune
    expect(rows[sessionKey(7)]).toBeUndefined()
  })

  it('answerKey is normalizeQuestion — accent/hyphen/case insensitive', () => {
    expect(answerKey('E-mail')).toBe(answerKey('email'))
    expect(answerKey('Por quê?')).toBe(answerKey('por que'))
  })
})
