import type { ResolutionTier } from '@jff/shared'

export const BTN =
  'cursor-pointer rounded-md border border-neutral-300 bg-transparent px-2.5 py-1 text-[13px] ' +
  'hover:border-blue-600 disabled:cursor-not-allowed disabled:opacity-50 ' +
  'dark:border-neutral-600 dark:hover:border-blue-400'

export const BTN_PRIMARY =
  `${BTN} border-blue-600 font-semibold text-blue-700 dark:border-blue-400 dark:text-blue-300`

export const INPUT =
  'w-full rounded-md border border-neutral-300 bg-transparent px-1.5 py-1 text-[13px] ' +
  'text-neutral-900 dark:border-neutral-600 dark:text-neutral-100'

export const MUTED = 'text-neutral-500 dark:text-neutral-400'

/** The 3px left rule that tells the four tiers apart at a glance. */
export const TIER_ACCENT: Record<ResolutionTier, string> = {
  auto: 'border-l-green-600 dark:border-l-green-400',
  proposed: 'border-l-blue-600 dark:border-l-blue-400',
  needs_input: 'border-l-amber-500 dark:border-l-amber-400',
  skipped: 'border-l-neutral-300 opacity-60 dark:border-l-neutral-600',
}

export const ROW_BASE =
  'rounded-lg border border-l-[3px] border-neutral-200 p-2 dark:border-neutral-700'

/** One uniform busy pattern for every async button: swap the label, disable. */
export const busyLabel = (isBusy: boolean, idle: string, active: string): string => (isBusy ? active : idle)
