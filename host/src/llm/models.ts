/** Every LLM call the product makes, named so its model is chosen here and
 *  never inherited from whatever the CLI was last set to. See ADR 0005. */
export type LlmTask =
  | 'factsExtract'
  | 'mapping'
  | 'optionPick'
  | 'applyAddressPick'
  | 'applicationEmail'
  | 'applicationEmailCheck'
  | 'generate'
  | 'reviewDraft'
  | 'claudeAuthProbe'
  | 'codexAuthProbe'

/** Exact ids from the harness model table. Every product task runs on Opus
 *  until spec B (#64) decides providers and models; the structured-task
 *  runner sends a Claude id to the Claude CLI (routedRunner.ts), so a config
 *  override back to a gpt id puts that task on codex again. The codex sign-in
 *  probe stays on codex: it checks codex itself. */
export const DEFAULT_MODELS: Readonly<Record<LlmTask, string>> = Object.freeze({
  factsExtract: 'claude-opus-5-5',
  mapping: 'claude-opus-5-5',
  optionPick: 'claude-opus-5-5',
  applyAddressPick: 'claude-opus-5-5',
  applicationEmail: 'claude-opus-5-5',
  // The Application email's Draft check, on the Claude runner (handlers.ts).
  // Only a Claude model id works here.
  applicationEmailCheck: 'claude-opus-5-5',
  generate: 'claude-opus-5-5',
  reviewDraft: 'claude-opus-5-5',
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
