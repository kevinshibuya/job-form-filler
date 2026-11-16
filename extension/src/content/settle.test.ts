import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitForPageReady, waitForSettle } from './settle'

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = '<div id="root"></div>' })
afterEach(() => { vi.useRealTimers() })

describe('waitForSettle', () => {
  it('resolves after the quiet window when nothing mutates', async () => {
    const done = vi.fn()
    void waitForSettle(document, { quietMs: 300, maxMs: 5_000 }).then(done)
    await vi.advanceTimersByTimeAsync(299)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(done).toHaveBeenCalled()
  })

  it('restarts the quiet window on every mutation', async () => {
    const done = vi.fn()
    void waitForSettle(document, { quietMs: 300, maxMs: 5_000 }).then(done)
    await vi.advanceTimersByTimeAsync(200)
    document.getElementById('root')!.appendChild(document.createElement('span'))
    await vi.advanceTimersByTimeAsync(200)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(done).toHaveBeenCalled()
  })

  it('gives up at maxMs even if the page never stops mutating', async () => {
    const done = vi.fn()
    void waitForSettle(document, { quietMs: 300, maxMs: 1_000 }).then(done)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(150)
      document.getElementById('root')!.appendChild(document.createElement('span'))
    }
    await vi.advanceTimersByTimeAsync(50)
    expect(done).toHaveBeenCalled()
  })
})

// PR #36 final pass: a re-scan at a reload's navigation commit attached the
// resume before the page's uploader was ready, and the page refused it.
describe('waitForPageReady', () => {
  let state: DocumentReadyState = 'complete'
  beforeEach(() => {
    state = 'complete'
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => state })
  })
  afterEach(() => { delete (document as { readyState?: unknown }).readyState })

  it('an old, loaded document is ready at once', async () => {
    const done = vi.fn()
    void waitForPageReady(document, { age: () => 30_000 }).then(done)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalled()
  })

  it('a young, loaded document is ready only once quiet, and a mutation restarts the wait', async () => {
    const done = vi.fn()
    void waitForPageReady(document, { age: () => 500, quietMs: 1_000 }).then(done)
    await vi.advanceTimersByTimeAsync(600)
    document.getElementById('root')!.appendChild(document.createElement('span'))
    await vi.advanceTimersByTimeAsync(900)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(done).toHaveBeenCalled()
  })

  it('a loading document waits for load, then for quiet', async () => {
    state = 'loading'
    const done = vi.fn()
    void waitForPageReady(document, { age: () => 500, quietMs: 1_000 }).then(done)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(done).not.toHaveBeenCalled()
    state = 'complete'
    window.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(999)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(done).toHaveBeenCalled()
  })

  it('gives up at maxMs, load or not', async () => {
    state = 'loading'
    const done = vi.fn()
    void waitForPageReady(document, { age: () => 500, quietMs: 1_000, maxMs: 4_000 }).then(done)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(done).toHaveBeenCalled()
  })
})

