import { describe, it, expect } from 'vitest'
import { extractPdfText } from './cvText'

/** A minimal valid one-page PDF (Helvetica) whose page stream draws the text
 *  'Kevin Shibuya kevin@example.com'. Generated offline with correct xref
 *  offsets; 606 bytes. */
const TINY_PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2MiA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDcyIDcyMCBUZCAoS2V2aW4gU2hpYnV5YSBrZXZpbkBleGFtcGxlLmNvbSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNTMgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjMKJSVFT0YK'

const bytesOf = (b64: string): ArrayBuffer => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return bytes.buffer as ArrayBuffer
}

describe('extractPdfText', () => {
  it('extracts the text of a real (tiny) PDF', async () => {
    const text = await extractPdfText(bytesOf(TINY_PDF_B64))
    expect(text).toContain('Kevin Shibuya')
    expect(text).toContain('kevin@example.com')
  })

  it('returns null for bytes that are not a PDF', async () => {
    const bytes = new TextEncoder().encode('not a pdf at all')
    await expect(extractPdfText(bytes.buffer as ArrayBuffer)).resolves.toBeNull()
  })
})
