import { describe, it, expect } from 'vitest'
import { DEFAULT_MODELS, LLM_TASKS, resolveModels } from './models.js'

describe('DEFAULT_MODELS', () => {
  it('pins the exact id per task from the harness model table', () => {
    expect(DEFAULT_MODELS).toEqual({
      factsExtract: 'gpt-6.1-sol',
      mapping: 'gpt-6.1-sol',
      optionPick: 'gpt-6.1-sol',
      applyAddressPick: 'gpt-6.1-sol',
      generate: 'claude-opus-5-5',
      reviewDraft: 'gpt-6.1-sol',
      claudeAuthProbe: 'claude-opus-5-5',
      codexAuthProbe: 'gpt-6-luna',
    })
  })

  it('names no retired id', () => {
    for (const id of Object.values(DEFAULT_MODELS)) {
      expect(id).not.toMatch(/^gpt-5\.6-/)
      expect(id).not.toBe('claude-opus-5')
    }
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

  it('routes the Option pick like Mapping, to the structured-task model', () => {
    expect(DEFAULT_MODELS.optionPick).toBe(DEFAULT_MODELS.mapping)
  })

  it('lets the Option pick be overridden on its own', () => {
    const r = resolveModels({ optionPick: 'gpt-6-astra' })
    expect(r.optionPick).toBe('gpt-6-astra')
    expect(r.mapping).toBe(DEFAULT_MODELS.mapping)
  })

  it('drops an empty-string override', () => {
    expect(resolveModels({ generate: '' }).generate).toBe(DEFAULT_MODELS.generate)
  })
})
