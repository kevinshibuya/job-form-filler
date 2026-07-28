/**
 * Chrome native-messaging stdio framing: 4-byte little-endian byte length,
 * then that many bytes of UTF-8 JSON. This module owns the ONLY bytes ever
 * written to stdout. Nothing else in host/ may touch process.stdout.
 */

export const MAX_HOST_TO_EXT_BYTES = 1_048_576 // Chrome's host->extension hard cap

export class MessageTooLarge extends Error {
  constructor(readonly byteLength: number) {
    super(`host->extension message is ${byteLength} bytes, over the ${MAX_HOST_TO_EXT_BYTES} byte cap`)
    this.name = 'MessageTooLarge'
  }
}

export function encodeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.byteLength > MAX_HOST_TO_EXT_BYTES) throw new MessageTooLarge(body.byteLength)
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.byteLength, 0)
  return Buffer.concat([head, body])
}

export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)

  /** Feed raw stdin bytes; returns every complete message now available. */
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.byteLength === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: unknown[] = []
    for (;;) {
      if (this.buf.byteLength < 4) break
      const len = this.buf.readUInt32LE(0)
      if (this.buf.byteLength < 4 + len) break
      const body = this.buf.subarray(4, 4 + len).toString('utf8')
      this.buf = this.buf.subarray(4 + len)
      try {
        out.push(JSON.parse(body))
      } catch (e) {
        out.push({ __parseError: true, message: String(e) })
      }
    }
    return out
  }
}
