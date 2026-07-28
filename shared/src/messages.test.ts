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
