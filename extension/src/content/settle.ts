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
