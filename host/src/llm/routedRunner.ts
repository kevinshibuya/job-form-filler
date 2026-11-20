import type { ClaudeRunner } from './claudeCli.js'
import type { CodexRunner } from './codexCli.js'

/** A model id the Claude CLI runs. Anything else is codex's. */
export function isClaudeModel(model: string): boolean {
  return model.startsWith('claude-')
}

/**
 * The structured-task runner (Mapping, the Option pick, the Apply address pick,
 * Facts extract, the Draft check): each call goes to the CLI its model belongs
 * to, so models.ts and the config choose the CLI along with the model.
 */
export function createModelRoutedRunner(claude: ClaudeRunner, codex: CodexRunner): CodexRunner {
  return {
    complete: (prompt, schema, opts) => (isClaudeModel(opts.model) ? claude : codex).complete(prompt, schema, opts),
  }
}
