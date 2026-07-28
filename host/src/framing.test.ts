import { describe, it, expect } from 'vitest'
import { encodeMessage, FrameReader, MessageTooLarge, MAX_HOST_TO_EXT_BYTES } from './framing.js'

describe('encodeMessage', () => {
  it('prefixes the UTF-8 byte length as 4-byte little-endian', () => {
    const buf = encodeMessage({ a: 1 })
    const body = Buffer.from(JSON.stringify({ a: 1 }), 'utf8')
    expect(buf.readUInt32LE(0)).toBe(body.byteLength)
    expect(buf.subarray(4).toString('utf8')).toBe(JSON.stringify({ a: 1 }))
  })

  it('counts BYTES not characters for multi-byte payloads', () => {
    const buf = encodeMessage({ s: 'ção' })
    const body = Buffer.from(JSON.stringify({ s: 'ção' }), 'utf8')
    expect(buf.readUInt32LE(0)).toBe(body.byteLength)
    expect(buf.byteLength).toBe(4 + body.byteLength)
  })

  it('throws MessageTooLarge strictly above 1 MB', () => {
    const big = { s: 'x'.repeat(MAX_HOST_TO_EXT_BYTES) }
    expect(() => encodeMessage(big)).toThrow(MessageTooLarge)
  })
})

describe('FrameReader', () => {
  it('parses a whole message from one chunk', () => {
    const r = new FrameReader()
    expect(r.push(encodeMessage({ hi: true }))).toEqual([{ hi: true }])
  })

  it('parses a message split across many chunks', () => {
    const r = new FrameReader()
    const buf = encodeMessage({ n: 42 })
    expect(r.push(buf.subarray(0, 2))).toEqual([])
    expect(r.push(buf.subarray(2, 6))).toEqual([])
    expect(r.push(buf.subarray(6))).toEqual([{ n: 42 }])
  })

  it('parses several messages coalesced into one chunk', () => {
    const r = new FrameReader()
    const buf = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 2 })])
    expect(r.push(buf)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('surfaces malformed JSON as an error entry rather than throwing', () => {
    const r = new FrameReader()
    const body = Buffer.from('{not json', 'utf8')
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.byteLength, 0)
    const out = r.push(Buffer.concat([head, body]))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ __parseError: true })
  })
})
