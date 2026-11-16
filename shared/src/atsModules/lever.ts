import type { AtsModule } from '../atsModule.js'

/** Lever. No rule yet: each one waits on a fixture (ADR 0007). Its climb to a
 *  checkbox group's question is already on the generic path and stays there. */
export const lever: AtsModule = Object.freeze({
  id: 'lever',
  emptyStateHint: 'On Lever the form opens from "Apply for this job". Open it, then Scan again.',
})
