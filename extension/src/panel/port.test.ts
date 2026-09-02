import { describe, it, expect, vi } from 'vitest'
import { createNativeHostPort, createRetryingHostPort, createHostPort, ERROR_COPY, hostErrorText } from './port'

/** Minimal chrome.runtime.Port double. */
function fakePort() {
  const listeners: ((msg: unknown) => void)[] = []
  const disconnects: (() => void)[] = []
  return {
    sent: [] as unknown[],
    postMessage(msg: unknown) { this.sent.push(msg) },
    onMessage: { addListener: (cb: (m: unknown) => void) => listeners.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => disconnects.push(cb) },
    disconnect: vi.fn(),
    emit(msg: unknown) { for (const l of listeners) l(msg) },
    die() { for (const d of disconnects) d() },
  }
}

describe('createNativeHostPort', () => {
  it('sends a request with a unique requestId and resolves the matching response', async () => {
    const p = fakePort()
    const port = createNativeHostPort(() => p as unknown as chrome.runtime.Port)
    const pending = port.request('profile.get', {})
    const sent = p.sent[0] as { requestId: string; method: string }
    expect(sent.method).toBe('profile.get')
    expect(sent.requestId).toMatch(/\S/)
    p.emit({ requestId: sent.requestId, ok: true, result: { email: 'k@x.com' } })
    await expect(pending).resolves.toEqual({ ok: true, result: { email: 'k@x.com' } })
  })

  it('routes concurrent responses to the right callers, out of order', async () => {
    const p = fakePort()
    const port = createNativeHostPort(() => p as unknown as chrome.runtime.Port)
    const a = port.request('profile.get', {})
    const b = port.request('answerBank.get', {})
    const [ra, rb] = p.sent as { requestId: string }[]
    p.emit({ requestId: rb!.requestId, ok: true, result: 'B' })
    p.emit({ requestId: ra!.requestId, ok: true, result: 'A' })
    await expect(a).resolves.toEqual({ ok: true, result: 'A' })
    await expect(b).resolves.toEqual({ ok: true, result: 'B' })
  })

  it('passes an error response through with its taxonomy kind', async () => {
    const p = fakePort()
    const port = createNativeHostPort(() => p as unknown as chrome.runtime.Port)
    const pending = port.request('resolve', {})
    const sent = p.sent[0] as { requestId: string }
    p.emit({ requestId: sent.requestId, ok: false, error: { kind: 'rate_limit', message: 'limit' } })
    await expect(pending).resolves.toEqual({ ok: false, error: { kind: 'rate_limit', message: 'limit' } })
  })

  it('rejects every pending request as unreachable when the port dies', async () => {
    const p = fakePort()
    const port = createNativeHostPort(() => p as unknown as chrome.runtime.Port)
    const pending = port.request('selfCheck', {})
    p.die()
    await expect(pending).resolves.toMatchObject({ ok: false, error: { kind: 'unreachable' } })
  })

  it('notifies onDisconnect subscribers', () => {
    const p = fakePort()
    const port = createNativeHostPort(() => p as unknown as chrome.runtime.Port)
    const cb = vi.fn()
    port.onDisconnect(cb)
    p.die()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('ignores a response whose requestId was never sent', async () => {
    const p = fakePort()
    const port = createNativeHostPort(() => p as unknown as chrome.runtime.Port)
    expect(() => p.emit({ requestId: 'ghost', ok: true, result: 1 })).not.toThrow()
  })
})

describe('createRetryingHostPort', () => {
  it('re-issues the SAME requestId through a fresh port after a disconnect, so the host can replay it', async () => {
    const p1 = fakePort()
    const p2 = fakePort()
    const ports = [p1, p2]
    let i = 0
    const port = createRetryingHostPort(() => createNativeHostPort(() => ports[i++]! as unknown as chrome.runtime.Port))
    const pending = port.request('profile.get', {})
    const first = p1.sent[0] as { requestId: string }
    p1.die()
    await new Promise((r) => setTimeout(r, 0)) // let the retry reach the fresh port
    const second = p2.sent[0] as { requestId: string }
    expect(second.requestId).toBe(first.requestId)
    p2.emit({ requestId: second.requestId, ok: true, result: 'replayed' })
    await expect(pending).resolves.toEqual({ ok: true, result: 'replayed' })
  })

  it('gives up after one retry and notifies onDisconnect subscribers', async () => {
    const ports = [fakePort(), fakePort(), fakePort()]
    let i = 0
    const port = createRetryingHostPort(() => createNativeHostPort(() => ports[i++]! as unknown as chrome.runtime.Port))
    const cb = vi.fn()
    port.onDisconnect(cb)
    const pending = port.request('selfCheck', {})
    ports[0]!.die()
    await new Promise((r) => setTimeout(r, 0))
    ports[1]!.die()
    await expect(pending).resolves.toMatchObject({ ok: false, error: { kind: 'unreachable' } })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(i).toBe(2) // exactly one reconnect, never a loop
  })

  it('opens exactly ONE replacement port when two in-flight requests die together', async () => {
    // Two host processes would mean two SQLite writers, which the whole
    // single-port design exists to prevent. The dead port must also be closed,
    // not merely dropped on the floor.
    const ports = [fakePort(), fakePort(), fakePort()]
    let made = 0
    const port = createRetryingHostPort(() =>
      createNativeHostPort(() => ports[made++]! as unknown as chrome.runtime.Port))
    const a = port.request('profile.get', {})
    const b = port.request('answerBank.get', {})
    ports[0]!.die()
    await new Promise((r) => setTimeout(r, 0))
    expect(made).toBe(2) // initial + ONE reconnect, not one reconnect per request
    expect(ports[0]!.disconnect).toHaveBeenCalledTimes(1)

    const [ra, rb] = ports[1]!.sent as { requestId: string }[]
    ports[1]!.emit({ requestId: ra!.requestId, ok: true, result: 'A' })
    ports[1]!.emit({ requestId: rb!.requestId, ok: true, result: 'B' })
    await expect(a).resolves.toEqual({ ok: true, result: 'A' })
    await expect(b).resolves.toEqual({ ok: true, result: 'B' })
  })
})

describe('createHostPort', () => {
  it('returns the in-page fake when the test flag is present', async () => {
    const port = createHostPort('?jffFakeHost=1')
    await expect(port.request('selfCheck', {})).resolves.toMatchObject({ ok: true })
  })
})

describe('ERROR_COPY', () => {
  it('has one message per taxonomy kind, matching the spec', () => {
    expect(ERROR_COPY.not_installed).toBe('AI helper not found. Check the host config path.')
    expect(ERROR_COPY.not_authed).toBe('AI helper not signed in. Run `claude` or `codex login` in a terminal, then retry.')
    expect(ERROR_COPY.rate_limit).toBe('Subscription rate limit. Retry later; fields are left as needs-input.')
    expect(ERROR_COPY.timeout).toBe('AI call failed. Retry or fill manually.')
    expect(ERROR_COPY.process).toBe('AI call failed. Retry or fill manually.')
    expect(ERROR_COPY.invalid_output).toBe('AI returned unusable output. Fields are left as needs-input.')
    expect(ERROR_COPY.unreachable).toBe('Local host unreachable. Re-run the install script, then reopen Chrome.')
  })

  it('uses no spaced em-dashes in any message', () => {
    for (const msg of Object.values(ERROR_COPY)) expect(msg).not.toMatch(/\s[—–]\s/)
  })
})

describe('hostErrorText', () => {
  it('returns the bare copy when the host sent no message', () => {
    expect(hostErrorText({ kind: 'timeout' })).toBe(ERROR_COPY.timeout)
    expect(hostErrorText({ kind: 'timeout', message: '  ' })).toBe(ERROR_COPY.timeout)
  })

  it('puts the host detail on a second line, so the vendor reaches the user', () => {
    const t = hostErrorText({ kind: 'not_authed', message: 'codex CLI is not logged in' })
    expect(t.split('\n')).toEqual([ERROR_COPY.not_authed, 'codex CLI is not logged in'])
  })

  it('never renders a spaced em-dash, the same rule ERROR_COPY is held to', () => {
    expect(hostErrorText({ kind: 'process', message: 'boom' })).not.toMatch(/\s[—–]\s/)
  })

  it('does not repeat the copy when the host echoes it back', () => {
    expect(hostErrorText({ kind: 'db', message: ERROR_COPY.db })).toBe(ERROR_COPY.db)
  })

  it('clips a flooding host detail', () => {
    const t = hostErrorText({ kind: 'bad_request', message: 'x'.repeat(500) })
    expect(t.length).toBeLessThan(300)
    expect(t.endsWith('…')).toBe(true)
  })
})

