import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitForSettle } from './settle'

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
