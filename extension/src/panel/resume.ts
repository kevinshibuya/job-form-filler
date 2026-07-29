const DB_NAME = 'jff'
const STORE = 'resume'
const KEY = 'current'

export interface StoredResume {
  name: string
  mimeType: string
  dataBase64: string
  /** B2a: text extracted from a PDF at upload; null = non-PDF or extraction
   *  failed. Absent (legacy record) = not yet attempted → loadResumeText
   *  extracts lazily and persists. */
  text: string | null
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = run(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    t.oncomplete = () => db.close()
  }))
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(b64: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return bytes.buffer as ArrayBuffer
}

const isPdf = (name: string, mimeType: string): boolean =>
  mimeType === 'application/pdf' || name.toLowerCase().endsWith('.pdf')

type ExtractFn = (data: ArrayBuffer) => Promise<string | null>
/** Lazy so the heavy pdfjs bundle loads only when a PDF is actually parsed —
 *  and so unit tests that inject a fake extractor never load it at all. */
const lazyExtract: ExtractFn = async (data) => (await import('./cvText')).extractPdfText(data)

/**
 * The resume FILE lives here, in the extension, and never crosses native
 * messaging. Its extracted TEXT does (user decision 2026-07-29): it feeds the
 * generation prompt and facts-from-CV as trusted candidate-authored context.
 */
export async function saveResume(file: File, extract: ExtractFn = lazyExtract): Promise<void> {
  const buf = await file.arrayBuffer()
  // Encode BEFORE extracting: pdf.js takes OWNERSHIP of the ArrayBuffer it is
  // given (it transfers it to its worker — fake or real), leaving `buf`
  // DETACHED, and every later read of it throws. Task 13's in-browser e2e
  // caught this; jsdom fakes never transfer, so unit tests could not.
  const dataBase64 = toBase64(new Uint8Array(buf))
  // Spec D2 silent degradation: extraction failure must NEVER break the
  // upload — the resume stores with text: null and generation proceeds
  // without the CV block. The guarded region includes the dynamic cvText
  // import (lazyExtract), so even a failed pdfjs LOAD degrades.
  let text: string | null = null
  try {
    text = isPdf(file.name, file.type) ? await extract(buf) : null
  } catch { /* spec D2: silent degradation */ }
  const record: StoredResume = {
    name: file.name,
    mimeType: file.type === '' ? 'application/octet-stream' : file.type,
    dataBase64,
    text,
  }
  await tx('readwrite', (s) => s.put(record, KEY))
}

export async function loadResume(): Promise<StoredResume | null> {
  const v = await tx<StoredResume | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<StoredResume | undefined>)
  return v ?? null
}

/** The stored CV text; for a pre-B2a record (no `text` property) extraction
 *  runs once, persists, and later calls answer from the store. A PERSISTED
 *  null is an answer (non-PDF or failed extraction), never retried. */
export async function loadResumeText(extract: ExtractFn = lazyExtract): Promise<string | null> {
  const r = await tx<StoredResume | undefined>('readonly', (s) => s.get(KEY) as IDBRequest<StoredResume | undefined>)
  if (r === undefined) return null
  if ('text' in r) return r.text
  const legacy = r as Omit<StoredResume, 'text'>
  // Same spec-D2 guard as saveResume: a throwing extractor (or a failed
  // dynamic pdfjs import) persists text: null instead of breaking the read.
  let text: string | null = null
  try {
    text = isPdf(legacy.name, legacy.mimeType) ? await extract(fromBase64(legacy.dataBase64)) : null
  } catch { /* spec D2: silent degradation */ }
  await tx('readwrite', (s) => s.put({ ...legacy, text }, KEY))
  return text
}

export async function clearResume(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY))
}
