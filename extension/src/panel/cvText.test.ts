import { describe, it, expect } from 'vitest'
import { extractPdfText, joinTextItems, type TextItemLike } from './cvText'

/** A minimal valid one-page PDF (Helvetica) whose page stream draws the text
 *  'Ada Lovelace ada@example.com'. Generated offline with correct xref
 *  offsets; 603 bytes. */
const TINY_PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1OSA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDcyIDcyMCBUZCAoQWRhIExvdmVsYWNlIGFkYUBleGFtcGxlLmNvbSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNTAgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjAKJSVFT0YK'

const bytesOf = (b64: string): ArrayBuffer => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return bytes.buffer as ArrayBuffer
}

describe('extractPdfText', () => {
  it('extracts the text of a real (tiny) PDF', async () => {
    const text = await extractPdfText(bytesOf(TINY_PDF_B64))
    expect(text).toContain('Ada Lovelace')
    expect(text).toContain('ada@example.com')
  })

  it('returns null for bytes that are not a PDF', async () => {
    const bytes = new TextEncoder().encode('not a pdf at all')
    await expect(extractPdfText(bytes.buffer as ArrayBuffer)).resolves.toBeNull()
  })
})

/** Positions are PDF user space: y DOWN the page is a DECREASING number, and a
 *  run's x is where it starts. `item(str, x, y, width)` reads left to right. */
const item = (str: string, x: number, y: number, width: number): TextItemLike =>
  ({ str, transform: [1, 0, 0, 1, x, y], width })

describe('joinTextItems', () => {
  it('does NOT insert spaces between the glyph runs of one word', () => {
    // The real regression: pdf.js hands back an email in three runs, and the
    // old join(' ') stored 'ada @ example.com' as the profile email.
    const runs = [item('ada', 72, 700, 24), item('@', 96, 700, 7), item('example.com', 103, 700, 70)]
    expect(joinTextItems(runs)).toBe('ada@example.com')
  })

  it('inserts a space where the runs are genuinely apart', () => {
    expect(joinTextItems([item('ada', 72, 700, 24), item('lovelace', 100, 700, 30)])).toBe('ada lovelace')
  })

  it('breaks a line when the run moves to a new y', () => {
    // The opposite failure: join('') glued these into 'ada lovelacesoftware'.
    const runs = [item('ada lovelace', 72, 700, 60), item('software engineer', 72, 680, 70)]
    expect(joinTextItems(runs)).toBe('ada lovelace\nsoftware engineer')
  })

  it('honours an explicit hasEOL', () => {
    const runs: TextItemLike[] = [{ ...item('one', 72, 700, 20), hasEOL: true }, item('two', 72, 700, 20)]
    expect(joinTextItems(runs)).toBe('one\ntwo')
  })

  it('tolerates an item with no width', () => {
    const runs: TextItemLike[] = [{ str: 'a', transform: [1, 0, 0, 1, 72, 700] }, item('b', 72, 700, 5)]
    expect(joinTextItems(runs)).toBe('ab')
  })

  it('returns an empty string for no items', () => {
    expect(joinTextItems([])).toBe('')
  })
})
