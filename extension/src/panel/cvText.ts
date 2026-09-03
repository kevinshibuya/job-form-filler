/**
 * PDF text extraction for the stored resume (B2a). pdfjs legacy build on the
 * MAIN thread: an MV3 panel + vite bundle makes a real worker more trouble
 * than the one small PDF we parse warrants. Registering the worker module on
 * `globalThis.pdfjsWorker` makes pdf.js use its in-thread "fake worker"
 * without ever fetching GlobalWorkerOptions.workerSrc — CSP-safe.
 *
 * Output is capped at 12000 chars (mirrors the host's CAPS.jobText) AT
 * EXTRACTION TIME: the cap bounds the IndexedDB record and the native
 * message, not just the prompt (review fix, codex item 11).
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs'

;(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker

/** The part of a pdf.js text item that joining needs. `transform` is pdf.js's
 *  [a, b, c, d, x, y]; positions are PDF user-space units (1/72 inch). */
export interface TextItemLike {
  str: string
  transform: number[]
  width?: number
  hasEOL?: boolean
}

/** Below a space's width at any readable font size, above float noise. */
const LINE_EPSILON = 1
const GAP_EPSILON = 1

/**
 * pdf.js splits a line into GLYPH RUNS, not words: an email arrives as
 * ['hello', '@', 'kevinshibuya.com']. Joining those with a space wrote
 * 'hello @ kevinshibuya.com' into the profile — a corrupt email in every
 * filled form — and joining with nothing glues consecutive lines into
 * 'kevin shibuyasoftware engineer'. Neither is a spacing rule; the geometry
 * is. A run starting on a new y begins a line; a run starting further right
 * than the previous one ended has a real gap; anything else continues the
 * same word.
 */
export function joinTextItems(items: readonly TextItemLike[]): string {
  let out = ''
  let prevEndX: number | null = null
  let prevY: number | null = null
  for (const it of items) {
    const x = it.transform[4] ?? 0
    const y = it.transform[5] ?? 0
    if (prevY !== null && Math.abs(y - prevY) > LINE_EPSILON) out += '\n'
    else if (prevEndX !== null && x - prevEndX > GAP_EPSILON) out += ' '
    out += it.str
    if (it.hasEOL === true) out += '\n'
    prevEndX = x + (it.width ?? 0)
    prevY = y
  }
  return out
}

export async function extractPdfText(data: ArrayBuffer): Promise<string | null> {
  try {
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise
    const parts: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      // pdf.js yields TextItem | TextMarkedContent; only the former carries text.
      // Extract<> narrows without importing pdf.js's internal type paths, and a
      // TextItem structurally satisfies TextItemLike.
      const texts = content.items.filter(
        (it): it is Extract<(typeof content.items)[number], { str: string }> => 'str' in it,
      )
      parts.push(joinTextItems(texts))
    }
    await doc.destroy()
    const text = parts.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    // Cap at storage time — see the docblock.
    return text === '' ? null : text.slice(0, 12_000)
  } catch {
    // Encrypted, corrupt, or not a PDF: generation proceeds without the CV
    // block (silent degradation per spec D2).
    return null
  }
}
