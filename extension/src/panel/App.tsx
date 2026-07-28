import { useEffect, useRef, useState } from 'react'
import type { SelfCheck } from '@jff/shared'
import { SelfCheckBanner } from './Banner'
import { createHostPort, ERROR_COPY, type HostPort } from './port'
import { createTabScope } from './tabScope'

export function App() {
  const portRef = useRef<HostPort | null>(null)
  const [check, setCheck] = useState<SelfCheck | null>(null)
  const [hostError, setHostError] = useState<string | null>(null)
  const [tabId, setTabId] = useState<number | null>(null)
  // Bumped ONLY when the bound tab navigated. Task 20 Step 9 makes this the
  // re-scan trigger; a tab switch or close must clear state without re-scanning.
  const [scanNonce, setScanNonce] = useState(0)
  const [resetCount, setResetCount] = useState(0)

  useEffect(() => {
    const port = createHostPort()
    portRef.current = port
    port.onDisconnect(() => setHostError(ERROR_COPY.unreachable))
    void port.request<SelfCheck>('selfCheck', {}).then((r) => {
      if (r.ok) setCheck(r.result)
      else setHostError(ERROR_COPY[r.error.kind])
    })
    return () => port.disconnect()
  }, [])

  useEffect(() => {
    let stop: (() => void) | null = null
    // Unmounting before tabs.query resolves would otherwise register listeners
    // that nothing ever removes.
    let cancelled = false
    const bind = (id: number | null): void => {
      if (cancelled) return
      setTabId(id)
      if (id === null) return
      stop = createTabScope(id, (reason) => {
        setResetCount((n) => n + 1)
        if (reason === 'navigated') setScanNonce((n) => n + 1)
      })
    }
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => bind(tabs[0]?.id ?? null))
    return () => { cancelled = true; if (stop !== null) stop() }
  }, [])

  return (
    <main className="p-3" data-jff-ready="1">
      <header className="flex items-center justify-between border-b border-neutral-200 pb-2 dark:border-neutral-700">
        <h1 className="m-0 text-[13px] font-semibold tracking-wide" data-jff-title="1">job-form-filler</h1>
        <span className="text-neutral-500 tabular-nums dark:text-neutral-400" data-jff-tab={String(tabId ?? '')}>
          {tabId === null ? 'no tab' : `tab ${tabId}`}
        </span>
      </header>
      <SelfCheckBanner check={check} error={hostError} />
      <p className="mt-3 text-neutral-500 dark:text-neutral-400" data-jff-resets={String(resetCount)} data-jff-scans={String(scanNonce)}>
        Open a job application, then press Scan.
      </p>
    </main>
  )
}
