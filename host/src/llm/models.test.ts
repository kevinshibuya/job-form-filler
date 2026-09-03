import { describe, it, expect } from 'vitest'
import { DEFAULT_MODELS, LLM_TASKS, resolveModels } from './models.js'

describe('DEFAULT_MODELS', () => {
  it('pins the exact id per task from the harness model table', () => {
    expect(DEFAULT_MODELS).toEqual({
      factsExtract: 'gpt-5.6-sol',
      mapping: 'gpt-5.6-sol',
      generate: 'claude-opus-5',
      reviewDraft: 'gpt-5.6-sol',
      claudeAuthProbe: 'claude-opus-5',
      codexAuthProbe: 'gpt-5.6-luna',
    })
  })

  it('LLM_TASKS lists every key of the table', () => {
    expect([...LLM_TASKS].sort()).toEqual(Object.keys(DEFAULT_MODELS).sort())
  })
})

describe('resolveModels', () => {
  it('returns the defaults when there are no overrides', () => {
    expect(resolveModels({})).toEqual(DEFAULT_MODELS)
  })

  it('lets a valid override win', () => {
    expect(resolveModels({ generate: 'claude-fable-5-1' }).generate).toBe('claude-fable-5-1')
  })

  it('leaves the other tasks on their defaults when one is overridden', () => {
    const r = resolveModels({ generate: 'claude-fable-5-1' })
    expect(r.mapping).toBe(DEFAULT_MODELS.mapping)
    expect(r.reviewDraft).toBe(DEFAULT_MODELS.reviewDraft)
  })

  it('drops an empty-string override', () => {
    expect(resolveModels({ generate: '' }).generate).toBe(DEFAULT_MODELS.generate)
  })
})
