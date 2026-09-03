import type { SelfCheck } from '@jff/shared'

// One shared shape for all four banner states; only the colour pair changes.
const BANNER_BASE = 'my-2.5 rounded-md border px-2.5 py-2'
const BANNER_NEUTRAL = 'border-neutral-200 dark:border-neutral-700'
const BANNER_GOOD = 'border-green-600/50 bg-green-600/10 dark:border-green-400/50'
const BANNER_BAD = 'border-red-600/50 bg-red-600/10 dark:border-red-400/50'

export function SelfCheckBanner({ check, error }: { check: SelfCheck | null; error: string | null }) {
  if (error !== null) {
    return (
      <div className={`${BANNER_BASE} ${BANNER_BAD} whitespace-pre-line`} role="status" data-jff-banner="error">
        <strong className="font-semibold">Host problem.</strong> {error}
      </div>
    )
  }
  if (check === null) {
    return (
      <div className={`${BANNER_BASE} ${BANNER_NEUTRAL} text-neutral-500 dark:text-neutral-400`} role="status" data-jff-banner="pending">
        Checking the local host…
      </div>
    )
  }

  const problems: string[] = []
  if (!check.node.ok) problems.push(`Node ${check.node.version} is too old. Install Node 20 or newer.`)
  if (!check.claude.ok) problems.push(check.claude.detail)
  if (!check.auth.ok) problems.push(check.auth.detail)
  if (!check.codex.ok) problems.push(check.codex.detail)
  if (!check.codexAuth.ok) problems.push(check.codexAuth.detail)
  if (!check.db.ok) problems.push(`Database not writable at ${check.db.path}.`)

  if (problems.length === 0) {
    return (
      <div className={`${BANNER_BASE} ${BANNER_GOOD}`} role="status" data-jff-banner="ok">
        Host ready. Node {check.node.version}, claude and codex found, both signed in.
      </div>
    )
  }
  return (
    <div className={`${BANNER_BASE} ${BANNER_BAD}`} role="status" data-jff-banner="degraded">
      <strong className="font-semibold">Host not ready.</strong>
      <ul className="mt-1.5 list-disc pl-4">{problems.map((p) => <li className="my-0.5" key={p}>{p}</li>)}</ul>
    </div>
  )
}

export { BANNER_BASE, BANNER_BAD }
