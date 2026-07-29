import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { saveResume, loadResume, loadResumeText, clearResume, type StoredResume } from './resume'

/**
 * jsdom's Blob implements only `slice`/`size`/`type` — `arrayBuffer()`, `text()`
 * and `stream()` are all missing (same class of gap as the DataTransfer shim in
 * content/fill.test.ts). Chrome has had Blob.arrayBuffer since 76, well below the
 * MV3 floor, so production stays unmodified; this only fills the jsdom hole, and
 * the `typeof` guard makes it inert anywhere the real method exists.
 */
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    writable: true,
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.onerror = () => reject(reader.error)
        reader.readAsArrayBuffer(this)
      })
    },
  })
}

beforeEach(async () => { await clearResume() })

describe('resume store', () => {
  it('returns null before anything is stored', async () => {
    await expect(loadResume()).resolves.toBeNull()
  })

  it('round-trips a file as base64 with its name and mime type', async () => {
    await saveResume(new File([new Uint8Array([1, 2, 3, 4])], 'kevin-cv.pdf', { type: 'application/pdf' }), async () => null)
    const stored = await loadResume()
    expect(stored).toMatchObject({ name: 'kevin-cv.pdf', mimeType: 'application/pdf' })
    expect(atob(stored!.dataBase64)).toHaveLength(4)
  })

  it('replaces the previous resume rather than accumulating', async () => {
    await saveResume(new File(['a'], 'old.pdf', { type: 'application/pdf' }), async () => null)
    await saveResume(new File(['bb'], 'new.pdf', { type: 'application/pdf' }), async () => null)
    expect((await loadResume())!.name).toBe('new.pdf')
  })

  it('clears the stored resume', async () => {
    await saveResume(new File(['a'], 'x.pdf', { type: 'application/pdf' }), async () => null)
    await clearResume()
    await expect(loadResume()).resolves.toBeNull()
  })
})

describe('resume CV text (B2a)', () => {
  it('stores extracted text beside the blob for a PDF', async () => {
    const extract = vi.fn(async () => 'CV TEXT')
    await saveResume(new File(['%PDF-1.4'], 'cv.pdf', { type: 'application/pdf' }), extract)
    expect(extract).toHaveBeenCalledTimes(1)
    expect(await loadResume()).toMatchObject({ name: 'cv.pdf', text: 'CV TEXT' })
    await expect(loadResumeText()).resolves.toBe('CV TEXT')
  })

  it('stores the bytes even when the extractor DETACHES the buffer (pdf.js transfers it)', async () => {
    // pdf.js takes OWNERSHIP of the ArrayBuffer handed to getDocument — after
    // extraction the caller's buffer is detached and every later read of it
    // throws "Cannot perform Construct on a detached ArrayBuffer". Task 13's
    // in-browser e2e caught this (the fake extractors above never transfer).
    const detaching = async (data: ArrayBuffer): Promise<string | null> => {
      structuredClone(data, { transfer: [data] })
      return 'CV TEXT'
    }
    await saveResume(new File([new Uint8Array([1, 2, 3, 4])], 'cv.pdf', { type: 'application/pdf' }), detaching)
    const stored = await loadResume()
    expect(stored).toMatchObject({ name: 'cv.pdf', text: 'CV TEXT' })
    expect(atob(stored!.dataBase64)).toHaveLength(4)
  })

  it('stores text: null for a non-PDF without calling the extractor', async () => {
    const extract = vi.fn(async () => 'never')
    await saveResume(new File(['plain'], 'cv.txt', { type: 'text/plain' }), extract)
    expect(extract).not.toHaveBeenCalled()
    expect((await loadResume())!.text).toBeNull()
  })

  it('stores text: null when extraction fails, and does NOT retry it lazily', async () => {
    await saveResume(new File(['%PDF-1.4'], 'cv.pdf', { type: 'application/pdf' }), async () => null)
    expect((await loadResume())!.text).toBeNull()
    const retry = vi.fn(async () => 'late')
    await expect(loadResumeText(retry)).resolves.toBeNull()
    expect(retry).not.toHaveBeenCalled() // a persisted null is an answer, not a gap
  })

  it('an extractor that THROWS still stores the resume with text: null (spec D2)', async () => {
    await saveResume(new File(['%PDF-1.4'], 'cv.pdf', { type: 'application/pdf' }), async () => { throw new Error('pdfjs exploded') })
    expect(await loadResume()).toMatchObject({ name: 'cv.pdf', text: null })
  })

  it('lazily extracts, persists and reuses text for a pre-B2a record', async () => {
    // A legacy record has NO `text` property at all. Write one directly.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('jff', 1)
      req.onupgradeneeded = () => { req.result.createObjectStore('resume') }
      req.onsuccess = () => {
        const db = req.result
        const t = db.transaction('resume', 'readwrite')
        t.objectStore('resume').put(
          { name: 'old.pdf', mimeType: 'application/pdf', dataBase64: btoa('%PDF-1.4') } as unknown as StoredResume,
          'current',
        )
        t.oncomplete = () => { db.close(); resolve() }
        t.onerror = () => reject(t.error)
      }
      req.onerror = () => reject(req.error)
    })
    const extract = vi.fn(async () => 'LAZY TEXT')
    await expect(loadResumeText(extract)).resolves.toBe('LAZY TEXT')
    expect(extract).toHaveBeenCalledTimes(1)
    // Persisted: the second call answers from the store.
    const again = vi.fn(async () => 'should not run')
    await expect(loadResumeText(again)).resolves.toBe('LAZY TEXT')
    expect(again).not.toHaveBeenCalled()
  })

  it('returns null text when nothing is stored', async () => {
    await expect(loadResumeText()).resolves.toBeNull()
  })

  it('never clobbers a resume uploaded WHILE a legacy-migration extraction is in flight (review fix)', async () => {
    // A legacy record has NO `text` property at all. Write one directly.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('jff', 1)
      req.onupgradeneeded = () => { req.result.createObjectStore('resume') }
      req.onsuccess = () => {
        const db = req.result
        const t = db.transaction('resume', 'readwrite')
        t.objectStore('resume').put(
          { name: 'old.pdf', mimeType: 'application/pdf', dataBase64: btoa('%PDF-1.4') } as unknown as StoredResume,
          'current',
        )
        t.oncomplete = () => { db.close(); resolve() }
        t.onerror = () => reject(t.error)
      }
      req.onerror = () => reject(req.error)
    })

    let releaseExtractor: (text: string) => void = () => {}
    const deferredExtract = vi.fn(
      () => new Promise<string | null>((resolve) => { releaseExtractor = resolve }),
    )

    const loadPromise = loadResumeText(deferredExtract)
    // Mid-extraction: the user uploads a DIFFERENT resume.
    await saveResume(new File(['new bytes'], 'fresh.pdf', { type: 'application/pdf' }), async () => 'FRESH TEXT')
    // Now let the stale extraction resolve.
    releaseExtractor('STALE LEGACY TEXT')

    const returned = await loadPromise
    // The freshly-uploaded record must survive untouched in IndexedDB...
    await expect(loadResume()).resolves.toMatchObject({ name: 'fresh.pdf', text: 'FRESH TEXT' })
    // ...and the caller must get the fresh record's text, never the stale
    // legacy-migration text written over it.
    expect(returned).toBe('FRESH TEXT')
    expect(returned).not.toBe('STALE LEGACY TEXT')
  })
})
