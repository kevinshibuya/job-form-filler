import { describe, it, expect } from 'vitest'
import { EnumFieldSchema, HostRequestSchema, HostResponseSchema, ContentMessageSchema } from './messages.js'

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
  it('accepts a resolve request', () => {
    const req = HostRequestSchema.parse({
      requestId: 'r1', method: 'resolve',
      params: { epoch: 7, url: 'https://boards.greenhouse.io/x', hostname: 'boards.greenhouse.io', company: 'X', jobText: 'hi', fields: [] },
    })
    expect(req.method).toBe('resolve')
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
      fills: [{ handle, value: 'kevin@example.com' }],
    })
    expect(msg.type).toBe('JFF_FILL')
  })
})
