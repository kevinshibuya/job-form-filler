/** storage.session key for the last snapshot pushed from {tabId, frameId}. */
export const snapshotKey = (tabId: number, frameId: number): string => `jff:snap:${tabId}:${frameId}`
export const SNAPSHOT_KEY_RE = /^jff:snap:(\d+):(\d+)$/
