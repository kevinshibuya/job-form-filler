import type { AtsModule } from '../atsModule.js'

/** Ashby. No rule yet: each one waits on a fixture (ADR 0007). Its label repair
 *  is already on the generic path and stays there. */
export const ashby: AtsModule = Object.freeze({
  id: 'ashby',
  emptyStateHint: 'On Ashby the form is under the "Application" tab. Open it, then Scan again.',
})
