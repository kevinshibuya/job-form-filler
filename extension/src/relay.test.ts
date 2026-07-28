import { describe, it, expect, vi } from 'vitest'
import { broadcast, type RelayDeps } from './relay'

function makeDeps(over: Partial<RelayDeps> = {}): RelayDeps {
  return {
    discoverFrames: vi.fn(async () => [
      { frameId: 0, url: 'https://top.example/apply' },
      { frameId: 7, url: 'https://ats.example/embed' },
    ]),
    sendToFrame: vi.fn(async (_tabId, frameId) => ({ ok: true, from: frameId })),
    ...over,
  }
}

describe('broadcast', () => {
  it('stamps every reply with the frame id and url from discovery', async () => {
    const out = await broadcast(makeDeps(), 1, { type: 'JFF_PROBE' })
    expect(out.replies).toEqual([
      { frameId: 0, url: 'https://top.example/apply', payload: { ok: true, from: 0 } },
      { frameId: 7, url: 'https://ats.example/embed', payload: { ok: true, from: 7 } },
    ])
    expect(out.failures).toEqual([])
  })

  it('records a failing frame in failures and still returns the other replies', async () => {
    // This is the silent-skip fix: before this module, a frame whose sendMessage
    // threw simply vanished from the reply set.
    const deps = makeDeps({
      sendToFrame: vi.fn(async (_tabId, frameId) => {
        if (frameId === 7) throw new Error('Could not establish connection')
        return { ok: true, from: frameId }
      }),
    })
    const out = await broadcast(deps, 1, { type: 'JFF_SCAN', epoch: 1 })
    expect(out.replies.map((r) => r.frameId)).toEqual([0])
    expect(out.failures).toEqual([
      { frameId: 7, url: 'https://ats.example/embed', error: 'Error: Could not establish connection' },
    ])
  })

  it('propagates a discovery failure instead of inventing an empty result', async () => {
    const deps = makeDeps({ discoverFrames: vi.fn(async () => { throw new Error('no tab') }) })
    await expect(broadcast(deps, 1, { type: 'JFF_PROBE' })).rejects.toThrow('no tab')
  })

  it('passes the tab id and message through to every frame send', async () => {
    const deps = makeDeps()
    await broadcast(deps, 42, { type: 'JFF_SNAPSHOT', epoch: 9 })
    expect(deps.sendToFrame).toHaveBeenCalledWith(42, 0, { type: 'JFF_SNAPSHOT', epoch: 9 })
    expect(deps.sendToFrame).toHaveBeenCalledWith(42, 7, { type: 'JFF_SNAPSHOT', epoch: 9 })
  })
})
