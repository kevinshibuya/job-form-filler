/** storage.session key for the per-tab application session (S1). Lives beside
 *  snapshotKey.ts on purpose: the two regexes partition the jff:* namespace,
 *  and the disjointness is TESTED — no code path may treat an unrecognized row
 *  as a snapshot (or a session). */
export const sessionKey = (tabId: number): string => `jff:session:${tabId}`
export const SESSION_KEY_RE = /^jff:session:(\d+)$/
