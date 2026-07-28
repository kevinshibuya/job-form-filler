// The broadcast half of the service worker's relay, extracted so the
// failure-recording contract is unit-testable: a frame that cannot be reached
// must land in `failures`, never silently vanish from the reply set.

export interface RelayReply { frameId: number; url: string | null; payload: unknown }
export interface RelayFailure { frameId: number; url: string | null; error: string }

export interface RelayDeps {
  /** All frames of the tab, from a no-op executeScript (no webNavigation permission). */
  discoverFrames: (tabId: number) => Promise<{ frameId: number; url: string | null }[]>
  sendToFrame: (tabId: number, frameId: number, message: unknown) => Promise<unknown>
}

export async function broadcast(
  deps: RelayDeps, tabId: number, message: unknown,
): Promise<{ replies: RelayReply[]; failures: RelayFailure[] }> {
  const frames = await deps.discoverFrames(tabId)
  const replies: RelayReply[] = []
  const failures: RelayFailure[] = []
  for (const f of frames) {
    try {
      replies.push({ frameId: f.frameId, url: f.url, payload: await deps.sendToFrame(tabId, f.frameId, message) })
    } catch (e) {
      // Frame gone mid-broadcast, or the content script is not in it. The panel's
      // diagnostics need to SEE that, not infer it from an absent reply.
      failures.push({ frameId: f.frameId, url: f.url, error: String(e) })
    }
  }
  return { replies, failures }
}
