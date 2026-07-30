import type { HostErrorKind, HostRequest, HostResponse, SelfCheck } from '@jff/shared'

/** Compile-time test-seam flag, defined in vite.config.ts (and by vitest). A
 *  release build defines it false, which strips the fake port from the bundle. */
declare const __JFF_TEST_SEAM__: boolean

export const HOST_NAME = 'com.kevin.jobformfiller'

export type PortResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: { kind: HostErrorKind; message: string } }

export interface HostPort {
  /** `requestId` is normally generated; the retrying wrapper passes the SAME id on its replay. */
  request<T>(method: HostRequest['method'], params: unknown, requestId?: string): Promise<PortResult<T>>
  onDisconnect(cb: () => void): void
  disconnect(): void
}

/** The spec's error table, rendered for a human. No spaced em-dashes. */
export const ERROR_COPY: Record<HostErrorKind, string> = {
  not_installed: 'claude CLI not found. Check the host config path.',
  not_authed: 'claude CLI not logged in. Run `claude` once in a terminal.',
  rate_limit: 'Subscription rate limit. Retry later; fields are left as needs-input.',
  timeout: 'claude call failed. Retry or fill manually.',
  process: 'claude call failed. Retry or fill manually.',
  invalid_output: 'claude returned unusable output. Fields are left as needs-input.',
  db: 'Local database error. See ~/.job-form-filler/host.log.',
  bad_request: 'The panel sent something the host did not understand. Re-scan.',
  unreachable: 'Local host unreachable. Re-run the install script, then reopen Chrome.',
}

type Pending = (r: PortResult<unknown>) => void

export function createNativeHostPort(connect: () => chrome.runtime.Port = () => chrome.runtime.connectNative(HOST_NAME)): HostPort {
  const port = connect()
  const pending = new Map<string, Pending>()
  const disconnectCbs: (() => void)[] = []
  let alive = true

  port.onMessage.addListener((raw: unknown) => {
    const res = raw as HostResponse
    const resolve = pending.get(res?.requestId)
    if (resolve === undefined) return // a response we never asked for; ignore it
    pending.delete(res.requestId)
    resolve(res.ok ? { ok: true, result: res.result } : { ok: false, error: res.error })
  })

  port.onDisconnect.addListener(() => {
    // Reading lastError marks it handled; otherwise Chrome logs an
    // "Unchecked runtime.lastError" console error when no host is installed.
    // (typeof guard: unit tests drive this with a fake port and no chrome global.)
    if (typeof chrome !== 'undefined') void chrome.runtime.lastError
    alive = false
    for (const [, resolve] of pending) {
      resolve({ ok: false, error: { kind: 'unreachable', message: ERROR_COPY.unreachable } })
    }
    pending.clear()
    for (const cb of disconnectCbs) cb()
  })

  return {
    request<T>(method: HostRequest['method'], params: unknown, requestId: string = crypto.randomUUID()): Promise<PortResult<T>> {
      if (!alive) return Promise.resolve({ ok: false, error: { kind: 'unreachable', message: ERROR_COPY.unreachable } })
      return new Promise<PortResult<T>>((resolve) => {
        pending.set(requestId, resolve as Pending)
        port.postMessage({ requestId, method, params })
      })
    },
    onDisconnect(cb) { disconnectCbs.push(cb) },
    disconnect() { alive = false; port.disconnect() },
  }
}

/**
 * One reconnect-and-replay on top of the native port. A request that dies with
 * `unreachable` is re-sent ONCE, with the SAME requestId, through a fresh port
 * (Chrome relaunches the host on connectNative). If the first attempt completed
 * host-side, request_log replays the ORIGINAL response — a paid claude call is
 * never run twice. onDisconnect subscribers are notified only when the retry
 * also fails, so a successful reconnect never flashes an error banner.
 *
 * Deliberate: this wrapper does NOT subscribe to the inner port's onDisconnect. An
 * IDLE host death is invisible to the user and the next request reconnects
 * transparently, so a banner there would be a false alarm. Subscribers fire only
 * when a live request could not be completed even after the reconnect.
 */
export function createRetryingHostPort(makePort: () => HostPort = () => createNativeHostPort()): HostPort {
  let inner = makePort()
  const disconnectCbs: (() => void)[] = []
  return {
    async request<T>(method: HostRequest['method'], params: unknown, requestId: string = crypto.randomUUID()): Promise<PortResult<T>> {
      const failed = inner
      const first = await failed.request<T>(method, params, requestId)
      if (first.ok || first.error.kind !== 'unreachable') return first
      // Reconnect ONCE per dead port, not once per in-flight request. Concurrent
      // requests all observe the same dead `inner` and must share the ONE
      // replacement: a second connectNative would launch a second host process and
      // break the single-SQLite-writer invariant. The dead port is disconnected
      // rather than dropped, so Chrome tears its child process down.
      if (inner === failed) {
        failed.disconnect()
        inner = makePort()
      }
      const second = await inner.request<T>(method, params, requestId)
      if (!second.ok && second.error.kind === 'unreachable') for (const cb of disconnectCbs) cb()
      return second
    },
    onDisconnect(cb) { disconnectCbs.push(cb) },
    disconnect() { inner.disconnect() },
  }
}

declare global {
  interface Window {
    /** Injected by the Playwright full-loop smoke to bridge to a REAL host child process. */
    __jffHostBridge?: (req: { requestId: string; method: string; params: unknown }) => Promise<HostResponse>
  }
}

const FAKE_SELF_CHECK: SelfCheck = {
  node: { ok: true, version: 'v20.0.0' },
  claude: { ok: true, path: '(fake)', detail: 'found' },
  auth: { ok: true, detail: 'logged in' },
  db: { ok: true, path: '(fake)' },
}

/**
 * In-page stand-in for the native port. Two modes:
 *  - a Playwright test may install `window.__jffHostBridge`, in which case every
 *    request is forwarded to a real host process the test spawned;
 *  - otherwise it answers with harmless canned data so the panel can be rendered
 *    and clicked in a browser without any host installed.
 */
export function createFakeHostPort(): HostPort {
  return {
    async request<T>(method: HostRequest['method'], params: unknown, requestId: string = crypto.randomUUID()): Promise<PortResult<T>> {
      if (typeof window.__jffHostBridge === 'function') {
        const res = await window.__jffHostBridge({ requestId, method, params })
        return res.ok ? { ok: true, result: res.result as T } : { ok: false, error: res.error }
      }
      const canned: Record<string, unknown> = {
        selfCheck: FAKE_SELF_CHECK,
        // O3: the canned persona is ONBOARDED — a complete profile — so the
        // seam-built panel (e2e foundation, dev clicking around) lands on the
        // normal flow, not the onboarding gate. Gate tests install their own
        // __jffHostBridge with an empty profile.
        'profile.get': { email: 'fake@example.com', phone: '+1 555 0100', fullName: 'Fake User' },
        'answerBank.get': {},
        'selector.get': { selector: null },
        resolve: { epoch: 0, resolutions: [], llmError: null },
        generate: { draft: '' },
        save: { saved: 0 },
        'qa.list': { page: 0, done: true, items: [], omitted: 0 },
      }
      return { ok: true, result: (canned[method] ?? {}) as T }
    },
    onDisconnect() { /* the fake never disconnects */ },
    disconnect() { /* no-op */ },
  }
}

export function createHostPort(search: string = location.search): HostPort {
  // The && is load-bearing: with __JFF_TEST_SEAM__ defined false at build time,
  // the whole branch (and createFakeHostPort with it) is dead-code-eliminated
  // from the release bundle. No runtime seam ships.
  if (__JFF_TEST_SEAM__ && new URLSearchParams(search).get('jffFakeHost') === '1') {
    return createFakeHostPort()
  }
  return createRetryingHostPort()
}
