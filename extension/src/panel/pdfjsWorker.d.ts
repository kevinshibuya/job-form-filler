/**
 * pdfjs-dist@4.10.38 ships types for `pdf.mjs` (pdf.d.mts) but NONE for the
 * worker entry, so importing it is an implicit-any error under `strict`.
 * pdf.js reads exactly one property off the module we park on
 * `globalThis.pdfjsWorker` — `WorkerMessageHandler` (see
 * `PDFWorker.#mainThreadWorkerMessageHandler`) — and cvText.ts only forwards
 * the namespace, so declaring that single opaque export is enough. `unknown`,
 * never `any`.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
