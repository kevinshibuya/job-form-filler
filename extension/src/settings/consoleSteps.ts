import facts from '../../../docs/research/apply-by-email-facts.md?raw'

/**
 * The Mail wizard's console steps, read from the section `## Console steps` of
 * `docs/research/apply-by-email-facts.md` at build time. The document is the
 * one source: a step, its link or a value to paste changes there and nowhere
 * else.
 */
export interface ConsoleStep {
  /** The step's number in the document. */
  n: number
  title: string
  /** The console page, with `<PROJECT_ID>` where the project goes, or null
   *  when the step has no console page of its own. */
  link: string | null
  /** What the step says to type or click, as written (code spans in backticks). */
  paste: string
  /** Every distinct code span under Paste, in order: the values to copy. */
  values: string[]
  doneWhen: string
}

export const PROJECT_PLACEHOLDER = '<PROJECT_ID>'

export function parseConsoleSteps(markdown: string): ConsoleStep[] {
  const start = markdown.indexOf('\n## Console steps')
  if (start === -1) return []
  const rest = markdown.slice(start + 1)
  const next = rest.indexOf('\n## ', 1)
  const section = next === -1 ? rest : rest.slice(0, next)
  return section.split(/^### /m).slice(1).flatMap((block): ConsoleStep[] => {
    const heading = /^(\d+)\.\s+(.+)$/m.exec(block)
    const link = /^Link:\s*(.+)$/m.exec(block)
    const pasteAt = block.search(/^Paste:/m)
    const doneAt = block.search(/^Done when:/m)
    if (heading === null || link === null || pasteAt === -1 || doneAt === -1 || doneAt < pasteAt) return []
    const pasteLines = block.slice(pasteAt + 'Paste:'.length, doneAt).trim().split('\n').map((l) => l.trim())
    // A line that is one code span and nothing else is a value on its own line
    // (the scopes); it belongs to the values list, not to the sentence.
    const sentence = pasteLines.filter((l) => !/^`[^`]+`$/.test(l)).join(' ')
    const pasteText = pasteLines.join('\n')
    const target = link[1]!.trim()
    return [{
      n: Number(heading[1]),
      title: heading[2]!.trim(),
      link: /^https:\/\//.test(target) ? target : null,
      paste: sentence,
      values: [...new Set([...pasteText.matchAll(/`([^`]+)`/g)].map((m) => m[1]!))],
      doneWhen: block.slice(doneAt + 'Done when:'.length).trim().split('\n').map((l) => l.trim()).join(' '),
    }]
  })
}

export const CONSOLE_STEPS: readonly ConsoleStep[] = parseConsoleSteps(facts)

/** The step's console page on this project, or null when it has none or
 *  needs a Project ID that is not typed yet. */
export function stepLink(step: ConsoleStep, projectId: string): string | null {
  if (step.link === null) return null
  if (!step.link.includes(PROJECT_PLACEHOLDER)) return step.link
  const id = projectId.trim()
  return id === '' ? null : step.link.replace(PROJECT_PLACEHOLDER, encodeURIComponent(id))
}

/** The step that asks for the Project ID: the one that creates the project,
 *  which says to copy the ID into the wizard and has no project in its own link. */
export const asksProjectId = (step: ConsoleStep): boolean =>
  step.link !== null && !step.link.includes(PROJECT_PLACEHOLDER) && /Project ID/.test(step.paste)
