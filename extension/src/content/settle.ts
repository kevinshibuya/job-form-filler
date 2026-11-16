/**
 * Wait for the ATS's async resume auto-parse to finish. "Finished" means the DOM
 * has been quiet for `quietMs`; `maxMs` is a hard ceiling so a page with a polling
 * timer can never hang the scan.
 */
export function waitForSettle(root: Document, opts: { quietMs?: number; maxMs?: number } = {}): Promise<void> {
  const quietMs = opts.quietMs ?? 600
  const maxMs = opts.maxMs ?? 8_000

  return new Promise<void>((resolve) => {
    let quietTimer = 0
    const deadline = setTimeout(finish, maxMs)
    const observer = new MutationObserver(restart)

    function finish(): void {
      clearTimeout(quietTimer)
      clearTimeout(deadline)
      observer.disconnect()
      resolve()
    }
    function restart(): void {
      clearTimeout(quietTimer)
      quietTimer = setTimeout(finish, quietMs) as unknown as number
    }

    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
    restart()
  })
}

/**
 * Wait until a page is ready to take a write. A document loaded long ago is
 * ready at once. A young one (a reload a re-scan followed at its navigation
 * commit) first waits for `load`, then for the DOM to stay quiet for `quietMs`:
 * an ATS hydrates and fetches its upload targets after load, and a change
 * event before that is refused. `maxMs` caps the whole wait.
 */
export function waitForPageReady(
  root: Document,
  opts: { age?: () => number; quietMs?: number; maxMs?: number; oldMs?: number } = {},
): Promise<void> {
  const age = opts.age ?? (() => performance.now())
  const quietMs = opts.quietMs ?? 1_000
  const maxMs = opts.maxMs ?? 8_000
  const oldMs = opts.oldMs ?? 10_000
  if (root.readyState === 'complete' && age() >= oldMs) return Promise.resolve()
  const start = Date.now()
  const loaded = new Promise<void>((resolve) => {
    if (root.readyState === 'complete') { resolve(); return }
    const view = root.defaultView
    if (view === null) { resolve(); return }
    view.addEventListener('load', () => resolve(), { once: true })
  })
  let capTimer: ReturnType<typeof setTimeout> | undefined
  const cap = new Promise<void>((resolve) => { capTimer = setTimeout(resolve, maxMs) })
  return Promise.race([
    loaded.then(() => waitForSettle(root, { quietMs, maxMs: Math.max(0, maxMs - (Date.now() - start)) })),
    cap,
  ]).finally(() => clearTimeout(capTimer))
}
