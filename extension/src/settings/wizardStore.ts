/**
 * Where the Mail wizard keeps its place: the Project ID and the steps marked
 * done. It lives in the extension's local storage, which survives closing the
 * page and restarting the browser. Session storage would not: Chrome empties
 * it on a restart.
 */
export interface WizardState {
  projectId: string
  /** The numbers of the steps marked done. */
  done: number[]
}

export const WIZARD_KEY = 'jff.mailWizard'

const EMPTY: WizardState = { projectId: '', done: [] }

export async function loadWizard(): Promise<WizardState> {
  const row = (await chrome.storage.local.get(WIZARD_KEY))[WIZARD_KEY] as Partial<WizardState> | undefined
  if (row === undefined || row === null || typeof row !== 'object') return EMPTY
  return {
    projectId: typeof row.projectId === 'string' ? row.projectId : '',
    done: Array.isArray(row.done) ? row.done.filter((n): n is number => typeof n === 'number') : [],
  }
}

export async function saveWizard(state: WizardState): Promise<void> {
  await chrome.storage.local.set({ [WIZARD_KEY]: state })
}
