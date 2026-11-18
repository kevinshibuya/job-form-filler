/** Every LLM call the product makes, named so its model is chosen here and
 *  never inherited from whatever the CLI was last set to. See ADR 0005. */
export type LlmTask =
  | 'factsExtract'
  | 'mapping'
  | 'optionPick'
  | 'applyAddressPick'
  | 'applicationEmail'
  | 'generate'
  | 'reviewDraft'
  | 'claudeAuthProbe'
  | 'codexAuthProbe'

/** Exact ids from the harness model table. Claude writes prose, Codex runs the
 *  structured tasks. */
export const DEFAULT_MODELS: Readonly<Record<LlmTask, string>> = Object.freeze({
  factsExtract: 'gpt-6.1-sol',
  mapping: 'gpt-6.1-sol',
  // Routed like Mapping: a structured choice among closed alternatives.
  optionPick: 'gpt-6.1-sol',
  // Spec #66: a structured choice among the page's addresses, like the Option pick.
  applyAddressPick: 'gpt-6.1-sol',
  // Spec #66: a writer Task like Generation, on the same runner interface.
  applicationEmail: 'claude-opus-5-5',
  generate: 'claude-opus-5-5',
  reviewDraft: 'gpt-6.1-sol',
  claudeAuthProbe: 'claude-opus-5-5',
  codexAuthProbe: 'gpt-6-luna',
})

export const LLM_TASKS: readonly LlmTask[] = Object.freeze(
  Object.keys(DEFAULT_MODELS) as LlmTask[],
)

export type ModelOverrides = Partial<Record<LlmTask, string>>
export type ResolvedModels = Readonly<Record<LlmTask, string>>

/** Defaults with every non-empty string override applied. */
export function resolveModels(overrides: ModelOverrides): ResolvedModels {
  const out: Record<LlmTask, string> = { ...DEFAULT_MODELS }
  for (const task of LLM_TASKS) {
    const v = overrides[task]
    if (typeof v === 'string' && v !== '') out[task] = v
  }
  return out
}
