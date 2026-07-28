import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { saveResume, loadResume, clearResume } from './resume'

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
    await saveResume(new File([new Uint8Array([1, 2, 3, 4])], 'kevin-cv.pdf', { type: 'application/pdf' }))
    const stored = await loadResume()
    expect(stored).toMatchObject({ name: 'kevin-cv.pdf', mimeType: 'application/pdf' })
    expect(atob(stored!.dataBase64)).toHaveLength(4)
  })

  it('replaces the previous resume rather than accumulating', async () => {
    await saveResume(new File(['a'], 'old.pdf', { type: 'application/pdf' }))
    await saveResume(new File(['bb'], 'new.pdf', { type: 'application/pdf' }))
    expect((await loadResume())!.name).toBe('new.pdf')
  })

  it('clears the stored resume', async () => {
    await saveResume(new File(['a'], 'x.pdf', { type: 'application/pdf' }))
    await clearResume()
    await expect(loadResume()).resolves.toBeNull()
  })
})
