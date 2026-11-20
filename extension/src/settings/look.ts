/**
 * The settings page's classes, from `docs/design/settings-page-anatomy.md`:
 * rounded rectangles at two sizes (groups at 12px, controls at 8px), 1px
 * borders and hairlines, outline controls only, and one blue for a switch that
 * is on. Grounds step from the page to the nav column and the groups.
 */
export { MUTED } from '../panel/ui'

export const PAGE_GROUND = 'bg-neutral-50 dark:bg-neutral-950'
export const NAV_GROUND = 'bg-neutral-100 dark:bg-neutral-900'
export const HAIRLINE = 'border-neutral-200 dark:border-neutral-800'

/** A group: the reference's rounded rectangle, a step off the page's ground. */
export const CARD = `rounded-xl border ${HAIRLINE} bg-white dark:bg-neutral-900`

/** A section title, outside its group. */
export const H_SECTION = 'mt-0 mb-1 text-[17px] font-semibold'

export const CODE = 'font-mono text-[12px] text-neutral-800 dark:text-neutral-200'

/** An outline button that is a link. */
export const LINK_BUTTON =
  'inline-flex items-center whitespace-nowrap rounded-lg border border-neutral-300 px-3 py-1.5 text-[13px] ' +
  'text-inherit no-underline hover:border-blue-600 dark:border-neutral-700 dark:hover:border-blue-400'

/** A text action: no border, muted until hovered. */
export const TEXT_ACTION =
  'cursor-pointer border-0 bg-transparent p-0 text-[13px] text-neutral-500 hover:text-blue-700 ' +
  'dark:text-neutral-400 dark:hover:text-blue-300'

/** An outline text field. */
export const FIELD =
  'w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-1.5 font-mono text-[13px] ' +
  'dark:border-neutral-700'
