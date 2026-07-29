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

export async function extractPdfText(data: ArrayBuffer): Promise<string | null> {
  try {
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise
    const parts: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '))
    }
    await doc.destroy()
    const text = parts.join('\n').replace(/[ \t]+/g, ' ').trim()
    // Cap at storage time — see the docblock.
    return text === '' ? null : text.slice(0, 12_000)
  } catch {
    // Encrypted, corrupt, or not a PDF: generation proceeds without the CV
    // block (silent degradation per spec D2).
    return null
  }
}
