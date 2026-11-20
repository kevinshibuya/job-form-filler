import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createModelRoutedRunner, isClaudeModel } from './routedRunner.js'

/** The structured-task runner sends each call to the CLI its model belongs to. */

const fakes = () => {
  const claude = { complete: vi.fn(async () => 'from claude') }
  const codex = { complete: vi.fn(async () => 'from codex') }
  return { claude, codex, routed: createModelRoutedRunner(claude as never, codex as never) }
}

describe('createModelRoutedRunner', () => {
  it('sends a Claude model id to the Claude CLI, with the call unchanged', async () => {
    const { claude, codex, routed } = fakes()
    const schema = z.string()
    expect(await routed.complete('prompt', schema, { model: 'claude-opus-5-5', timeoutMs: 240_000 })).toBe('from claude')
    expect(claude.complete).toHaveBeenCalledWith('prompt', schema, { model: 'claude-opus-5-5', timeoutMs: 240_000 })
    expect(codex.complete).not.toHaveBeenCalled()
  })

  it('sends any other model id to codex', async () => {
    const { claude, codex, routed } = fakes()
    expect(await routed.complete('prompt', z.string(), { model: 'gpt-6.1-sol' })).toBe('from codex')
    expect(codex.complete).toHaveBeenCalledTimes(1)
    expect(claude.complete).not.toHaveBeenCalled()
  })
})

describe('isClaudeModel', () => {
  it('reads the claude- prefix only', () => {
    expect(isClaudeModel('claude-sonnet-5-5')).toBe(true)
    expect(isClaudeModel('gpt-6-luna')).toBe(false)
    expect(isClaudeModel('my-claude-model')).toBe(false)
  })
})
