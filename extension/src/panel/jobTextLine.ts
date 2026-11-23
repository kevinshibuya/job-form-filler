import { ATS_LIST, type AtsOrGeneric, type JobTextSource } from '@jff/shared'

/**
 * The line under the job description box (spec #41): how many characters of
 * Job posting text the Session holds and where they came from. A Session kept
 * before the source was shows the count alone.
 */
export function jobTextLine(text: string, source: JobTextSource | null, ats: AtsOrGeneric): string {
  const count = `${text.length} ${text.length === 1 ? 'character' : 'characters'}`
  return source === null ? count : `${count} · ${sourceWords(source, ats)}`
}

function sourceWords(source: JobTextSource, ats: AtsOrGeneric): string {
  switch (source) {
    case 'paste': return 'your paste'
    case 'link': return 'your link'
    case 'ats': {
      const name = ATS_LIST.find((a) => a.id === ats)?.name
      return name === undefined ? 'the posting page' : `the ${name} posting page`
    }
    case 'pick': return 'your pick'
    case 'heuristic': return 'a heuristic'
    case 'none': return 'nothing found'
  }
}

/** "Not the job description" is offered for a text the user did not write:
 *  a spot they picked, a heuristic's guess, or what their link gave. */
export const offersNotTheJob = (source: JobTextSource | null): boolean =>
  source === 'pick' || source === 'heuristic' || source === 'link'

/** Beside "nothing found", the three ways to supply the posting (spec #98). */
export const NOTHING_FOUND_WAYS = 'Give the posting\'s link below, paste its text, or pick it on the page.'
