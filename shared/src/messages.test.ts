import { describe, it, expect } from 'vitest'
import { EnumFieldSchema, HostRequestSchema, HostResponseSchema, ContentMessageSchema, FillReportSchema, ResolveFirstResultSchema, ResolveMappingResultSchema, SaveItemSchema, OptionPickResultSchema, ResolutionSchema } from './messages.js'

const handle = { frameId: 0, fid: 3, epoch: 7 }

describe('EnumFieldSchema', () => {
  it('accepts a well-formed field', () => {
    const parsed = EnumFieldSchema.parse({
      ...handle, label: 'First Name', name: 'first_name', idAttr: 'first_name',
      kind: 'text', options: [], required: true, visible: true,
      currentValue: '', demographic: false,
    })
    expect(parsed.fid).toBe(3)
  })

  it('rejects an unknown widget kind', () => {
    expect(() => EnumFieldSchema.parse({
      ...handle, label: null, name: null, idAttr: null, kind: 'canvas',
      options: [], required: false, visible: true, currentValue: null, demographic: false,
    })).toThrow()
  })

  it('accepts the choice kind with a description', () => {
    const r = EnumFieldSchema.safeParse({
      frameId: 0, fid: 1, epoch: 2, label: 'Authorized to work?', name: 'u1', idAttr: null,
      kind: 'choice', options: ['Yes', 'No'], required: true, visible: false,
      currentValue: null, demographic: false, description: 'Answer for your current country.',
    })
    expect(r.success).toBe(true)
  })

  it('accepts a field WITHOUT description (stale content script)', () => {
    const r = EnumFieldSchema.safeParse({
      frameId: 0, fid: 1, epoch: 2, label: 'X', name: null, idAttr: null,
      kind: 'text', options: [], required: false, visible: true,
      currentValue: null, demographic: false,
    })
    expect(r.success).toBe(true)
  })
})

describe('HostRequestSchema', () => {
  it('rejects the single resolve request, which the two Resolution requests replaced', () => {
    const gone = 'resolve'
    expect(HostRequestSchema.safeParse({
      requestId: 'r1', method: gone,
      params: { epoch: 7, url: 'https://boards.greenhouse.io/x', hostname: 'boards.greenhouse.io', company: 'X', jobText: 'hi', fields: [] },
    }).success).toBe(false)
  })

  it('rejects an unknown method', () => {
    expect(() => HostRequestSchema.parse({ requestId: 'r1', method: 'rm-rf', params: {} })).toThrow()
  })

  it('rejects a missing requestId', () => {
    expect(() => HostRequestSchema.parse({ method: 'selfCheck', params: {} })).toThrow()
  })

  it('accepts a generate request with and without a description', () => {
    const base = {
      requestId: 'r1', method: 'generate' as const,
      params: { handle: { frameId: 0, fid: 1, epoch: 2 }, questionRaw: 'Q', jobText: '', company: null },
    }
    expect(HostRequestSchema.safeParse(base).success).toBe(true)
    expect(HostRequestSchema.safeParse({
      ...base, params: { ...base.params, description: 'Please include a timeline.' },
    }).success).toBe(true)
  })

  it('round-trips the generate description instead of stripping it', () => {
    const parsed = HostRequestSchema.parse({
      requestId: 'r2', method: 'generate',
      params: { handle: { frameId: 0, fid: 1, epoch: 2 }, questionRaw: 'Q', jobText: '', company: null, description: 'D' },
    })
    if (parsed.method !== 'generate') throw new Error('wrong branch')
    expect(parsed.params.description).toBe('D')
  })
})

describe('Resolution in two requests', () => {
  const params = { epoch: 7, url: 'https://boards.greenhouse.io/x', hostname: 'boards.greenhouse.io', company: null, jobText: '', fields: [] }
  const resolution = { handle, tier: 'auto', value: 'ada@example.com', source: 'profile', key: 'email', answerId: null, reason: 'recognizer:email' }

  it('accepts resolve.first and resolve.mapping with the same Scan params', () => {
    for (const method of ['resolve.first', 'resolve.mapping'] as const) {
      const parsed = HostRequestSchema.parse({ requestId: `r-${method}`, method, params })
      expect(parsed.method).toBe(method)
    }
  })

  it('carries the Scan\'s ATS on either request, and accepts a request with none', () => {
    for (const method of ['resolve.first', 'resolve.mapping'] as const) {
      const parsed = HostRequestSchema.parse({ requestId: `r-${method}`, method, params: { ...params, ats: 'greenhouse' } })
      expect(parsed.params).toMatchObject({ ats: 'greenhouse' })
      const without = HostRequestSchema.parse({ requestId: `r0-${method}`, method, params })
      expect((without.params as { ats?: string }).ats).toBeUndefined()
    }
    expect(HostRequestSchema.safeParse({ requestId: 'r3', method: 'resolve.first', params: { ...params, ats: '' } }).success).toBe(false)
  })

  it('rejects either request without its fields', () => {
    const { fields: _fields, ...noFields } = params
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'resolve.first', params: noFields }).success).toBe(false)
    expect(HostRequestSchema.safeParse({ requestId: 'r2', method: 'resolve.mapping', params: noFields }).success).toBe(false)
  })

  it('shapes the resolve.first reply as resolutions plus pending handles', () => {
    expect(ResolveFirstResultSchema.safeParse({ epoch: 7, resolutions: [resolution], pending: [handle] }).success).toBe(true)
    expect(ResolveFirstResultSchema.safeParse({ epoch: 7, resolutions: [resolution] }).success).toBe(false)
  })

  it('shapes the resolve.mapping reply as resolutions plus the Mapping error', () => {
    expect(ResolveMappingResultSchema.safeParse({ epoch: 7, resolutions: [resolution], llmError: null }).success).toBe(true)
    expect(ResolveMappingResultSchema.safeParse({ epoch: 7, resolutions: [], llmError: { kind: 'rate_limit', message: 'limit' } }).success).toBe(true)
    expect(ResolveMappingResultSchema.safeParse({ epoch: 7, resolutions: [] }).success).toBe(false)
  })
})

describe('HostRequestSchema — applied.* (A1)', () => {
  it('accepts the three applied methods', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'applied.mark', params: { url: 'https://x.com/j/1', company: null, jobTitle: null } }).success).toBe(true)
    expect(HostRequestSchema.safeParse({ requestId: 'r2', method: 'applied.check', params: { url: 'https://x.com/j/1' } }).success).toBe(true)
    expect(HostRequestSchema.safeParse({ requestId: 'r3', method: 'applied.list', params: {} }).success).toBe(true)
  })

  it('rejects applied.mark without a url', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r4', method: 'applied.mark', params: { company: null, jobTitle: null } }).success).toBe(false)
  })
})

describe('HostResponseSchema', () => {
  it('accepts an error response with a taxonomy kind', () => {
    const res = HostResponseSchema.parse({
      requestId: 'r1', ok: false, error: { kind: 'not_authed', message: 'nope' },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects an error kind outside the taxonomy', () => {
    expect(() => HostResponseSchema.parse({
      requestId: 'r1', ok: false, error: { kind: 'kaboom', message: 'x' },
    })).toThrow()
  })
})

describe('ContentMessageSchema', () => {
  it('accepts a fill message carrying the identity triple', () => {
    const msg = ContentMessageSchema.parse({
      type: 'JFF_FILL', epoch: 7,
      fills: [{ handle, value: 'ada@example.com' }],
    })
    expect(msg.type).toBe('JFF_FILL')
  })

  it('carries the candidate words of a Value with its fill, and keeps them through parsing', () => {
    const msg = ContentMessageSchema.parse({
      type: 'JFF_FILL', epoch: 7,
      fills: [{ handle, value: 'Germany', candidates: ['Germany', 'Alemanha'] }, { handle, value: 'Ada' }],
    })
    expect(msg.type === 'JFF_FILL' && msg.fills.map((f) => f.candidates)).toEqual([['Germany', 'Alemanha'], undefined])
  })

  it('rejects candidate words that are not strings', () => {
    expect(ContentMessageSchema.safeParse({
      type: 'JFF_FILL', epoch: 7, fills: [{ handle, value: 'Germany', candidates: [1] }],
    }).success).toBe(false)
  })
})

describe('ResolutionSchema — candidate words (#26)', () => {
  const base = { handle, tier: 'auto', value: 'Germany', source: 'profile', key: 'country', answerId: null, reason: 'recognizer:country' }

  it('carries the candidate words of its Value through parsing', () => {
    const parsed = ResolveFirstResultSchema.parse({
      epoch: 7, resolutions: [{ ...base, candidates: ['Germany', 'Alemanha'] }], pending: [],
    })
    expect(parsed.resolutions[0]!.candidates).toEqual(['Germany', 'Alemanha'])
  })

  it('accepts a Resolution with no candidate words', () => {
    expect(ResolveFirstResultSchema.parse({ epoch: 7, resolutions: [base], pending: [] }).resolutions[0]!.candidates).toBeUndefined()
  })
})

describe('ContentMessageSchema — a Scan opens no menu (ADR 0009)', () => {
  it('rejects the removed message that opened dropdowns for a Scan, as any unknown one', () => {
    expect(ContentMessageSchema.safeParse({ type: 'JFF_HARVEST', epoch: 3, fids: [0, 4, 9] }).success).toBe(false)
    expect(ContentMessageSchema.safeParse({ type: 'JFF_NOPE', epoch: 3 }).success).toBe(false)
  })
})

describe('EnumFieldSchema — accept attribute (A8)', () => {
  it('accepts a file field carrying accept, and one without (stale content script)', () => {
    const base = {
      frameId: 0, fid: 1, epoch: 2, label: 'Resume', name: 'resume', idAttr: null,
      kind: 'file', options: [], required: true, visible: true,
      currentValue: null, demographic: false,
    }
    expect(EnumFieldSchema.safeParse({ ...base, accept: '.pdf,.doc,.docx' }).success).toBe(true)
    expect(EnumFieldSchema.safeParse(base).success).toBe(true)
  })

  it('round-trips accept instead of stripping it', () => {
    const parsed = EnumFieldSchema.parse({
      frameId: 0, fid: 1, epoch: 2, label: null, name: null, idAttr: null,
      kind: 'file', options: [], required: false, visible: false,
      currentValue: null, demographic: false, accept: 'application/pdf',
    })
    expect(parsed.accept).toBe('application/pdf')
  })
})

describe('FillReportSchema — committed canonical text (B1c)', () => {
  const handle = { frameId: 0, fid: 1, epoch: 7 }

  it('accepts filled entries carrying the committed page text (or null)', () => {
    const r = FillReportSchema.safeParse({
      epoch: 7,
      filled: [{ handle, committed: 'Brazil' }, { handle, committed: null }],
      failed: [],
    })
    expect(r.success).toBe(true)
  })

  it('carries the Options a choice Fill read, on a hit and on a miss', () => {
    const r = FillReportSchema.parse({
      epoch: 7,
      filled: [{ handle, committed: null, options: ['Yes', 'No'] }],
      failed: [{ handle, reason: 'no-matching-option', options: ['Yes', 'No'] }],
    })
    expect(r.filled[0]!.options).toEqual(['Yes', 'No'])
    expect(r.failed[0]!.options).toEqual(['Yes', 'No'])
  })

  it('accepts entries with no Options, as a text Fill reports them', () => {
    const r = FillReportSchema.parse({ epoch: 7, filled: [{ handle, committed: null }], failed: [{ handle, reason: 'value-rejected' }] })
    expect(r.filled[0]!.options).toBeUndefined()
    expect(r.failed[0]!.options).toBeUndefined()
  })

  it('rejects the old bare-handle filled shape', () => {
    const r = FillReportSchema.safeParse({ epoch: 7, filled: [handle], failed: [] })
    expect(r.success).toBe(false)
  })
})

describe('generate cvText + facts.extract (B2b/B6)', () => {
  it('accepts a generate request with optional cvText', () => {
    const r = HostRequestSchema.safeParse({
      requestId: 'g1', method: 'generate',
      params: { handle: { frameId: 0, fid: 1, epoch: 1 }, questionRaw: 'Why us?', jobText: '', company: null, cvText: 'CV BODY' },
    })
    expect(r.success).toBe(true)
  })

  it('still accepts a generate request without cvText', () => {
    const r = HostRequestSchema.safeParse({
      requestId: 'g2', method: 'generate',
      params: { handle: { frameId: 0, fid: 1, epoch: 1 }, questionRaw: 'Why us?', jobText: '', company: null },
    })
    expect(r.success).toBe(true)
  })

  it('accepts facts.extract with non-empty cvText and rejects empty', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'f1', method: 'facts.extract', params: { cvText: 'CV' } }).success).toBe(true)
    expect(HostRequestSchema.safeParse({ requestId: 'f2', method: 'facts.extract', params: { cvText: '' } }).success).toBe(false)
  })
})

describe('SaveItemSchema', () => {
  const item = {
    handle, questionRaw: 'Are you authorised to work?', answer: 'Yes',
    reusability: 'reusable' as const,
  }

  it('rejects a non-null fieldKey, so a fact can never ride Save answers into a store', () => {
    expect(SaveItemSchema.safeParse({ ...item, fieldKey: 'github' }).success).toBe(false)
    expect(SaveItemSchema.safeParse({ ...item, fieldKey: 'workAuth' }).success).toBe(false)
  })

  it('still requires the property, and accepts it as null', () => {
    expect(SaveItemSchema.safeParse({ ...item, fieldKey: null }).success).toBe(true)
    expect(SaveItemSchema.safeParse(item).success).toBe(false)
  })

  it('rejects a whole save request carrying a keyed item', () => {
    const r = HostRequestSchema.safeParse({
      requestId: 's1', method: 'save',
      params: {
        url: 'https://x.test/apply', company: null, jobTitle: null,
        items: [{ ...item, fieldKey: 'github' }], generatedCount: 0,
      },
    })
    expect(r.success).toBe(false)
  })
})

describe('option.pick — the model picks one of the page\'s Options (#31, ADR 0008)', () => {
  const pick = { label: 'Are you open to relocation?', value: 'Yes', options: ['Yes, I am', 'No, I am not'] }

  it('accepts a request carrying the label, the stored Value and the Options', () => {
    const r = HostRequestSchema.safeParse({ requestId: 'r1', method: 'option.pick', params: pick })
    expect(r.success).toBe(true)
  })

  it('refuses a request with no Options to pick from', () => {
    expect(HostRequestSchema.safeParse({ requestId: 'r1', method: 'option.pick', params: { ...pick, options: [] } }).success).toBe(false)
  })

  it('the reply is a position or none, and carries no text', () => {
    expect(OptionPickResultSchema.parse({ position: 1 })).toEqual({ position: 1 })
    expect(OptionPickResultSchema.parse({ position: null })).toEqual({ position: null })
    expect(OptionPickResultSchema.parse({ position: 0, value: 'Yes, definitely', text: 'x' })).toEqual({ position: 0 })
    expect(OptionPickResultSchema.safeParse({ position: 'Yes' }).success).toBe(false)
    expect(OptionPickResultSchema.safeParse({ position: -1 }).success).toBe(false)
    expect(OptionPickResultSchema.safeParse({ position: 1.5 }).success).toBe(false)
  })
})

describe('ResolutionSchema — the stored Value a picked Option stands for (#31)', () => {
  it('round-trips standsFor', () => {
    const r = ResolutionSchema.parse({
      handle, tier: 'proposed', value: 'Yes, I am', source: 'answer_bank', key: 'relocate', answerId: null,
      reason: 'option-pick', standsFor: 'Yes',
    })
    expect(r.standsFor).toBe('Yes')
  })
})
