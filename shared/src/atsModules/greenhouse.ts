import type { AtsModule } from '../atsModule.js'

/** Greenhouse. No rule yet: each one waits on a fixture (ADR 0007). Its upload
 *  markup is already handled on the generic path and stays there. */
export const greenhouse: AtsModule = Object.freeze({ id: 'greenhouse' })
