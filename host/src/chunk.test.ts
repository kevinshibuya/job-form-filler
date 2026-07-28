import { describe, it, expect } from 'vitest'
import { paginate } from './chunk.js'
import { encodeMessage } from './framing.js'

describe('paginate', () => {
  it('returns done=true for a small single page', () => {
    const r = paginate([{ a: 1 }, { a: 2 }], 0)
    expect(r).toEqual({ page: 0, done: true, items: [{ a: 1 }, { a: 2 }], omitted: 0 })
  })

  it('splits when the page would exceed the byte budget and marks done on the last page', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ i, text: 'y'.repeat(100) }))
    const p0 = paginate(items, 0, 1_000)
    expect(p0.done).toBe(false)
    expect(p0.items.length).toBeGreaterThan(0)
    expect(p0.items.length).toBeLessThan(items.length)

    let seen = p0.items.length
    let page = 1
    let done = false
    while (!done && page < 100) {
      const p = paginate(items, page, 1_000)
      seen += p.items.length
      done = p.done
      page++
    }
    expect(done).toBe(true)
    expect(seen).toBe(items.length)
  })

  it('omits an item that alone exceeds the budget and reports it, so no page can ever break the frame cap', () => {
    const items = [{ text: 'z'.repeat(5_000) }, { text: 'ok' }]
    const r = paginate(items, 0, 100)
    expect(r.items).toEqual([{ text: 'ok' }])
    expect(r.omitted).toBe(1)
    expect(r.done).toBe(true)
  })

  it('emits pages that all survive encodeMessage under the real 1 MB cap', () => {
    // ~2.4 MB of items forces several pages; every FRAMED page must fit.
    const items = Array.from({ length: 40 }, (_, i) => ({ i, text: 'y'.repeat(60_000) }))
    let page = 0
    let done = false
    while (!done && page < 100) {
      const p = paginate(items, page)
      expect(() => encodeMessage({ requestId: 'r', ok: true, result: p })).not.toThrow()
      done = p.done
      page++
    }
    expect(done).toBe(true)
    expect(page).toBeGreaterThan(1)
  })

  it('returns an empty done page past the end', () => {
    expect(paginate([{ a: 1 }], 5)).toEqual({ page: 5, done: true, items: [], omitted: 0 })
  })
})
